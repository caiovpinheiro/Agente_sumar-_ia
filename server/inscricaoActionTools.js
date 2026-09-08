/**
 * Executores das tools de ação de inscrição.
 *
 * Princípio: o LLM **invoca** uma destas tools quando quer disparar uma ação;
 * o servidor executa e devolve um **texto canônico** (`replyOverride`) que
 * substitui qualquer narrativa do LLM no turno. Assim a resposta que chega ao
 * lead nunca diverge da ação que realmente aconteceu.
 *
 * Cada tool grava `inscricao_form_status` ANTES de qualquer disparo
 * (salesbot/captação) — transição atômica, à prova de reentrância.
 *
 * Retorno padrão:
 *   {
 *     ok:        boolean,         // ação concluída com sucesso
 *     code:      string,          // FORM_SENT_OK | POLO_NEEDED | ...
 *     text:      string,          // mensagem curta para o LLM (tool message)
 *     replyOverride: string,      // mensagem definitiva para o lead (sobrescreve LLM)
 *     ctxSnapshot:  object,       // estado p/ telemetria
 *     steps:        array,        // passos p/ orchestratorSteps
 *   }
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  buildInscricaoFormSentReply,
  buildFormAwaitingFillReply,
  buildFormNotReceivedResendReply,
  shouldBlockFormularioSumResend,
  inscricaoFormAlreadyFilled,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  messageLooksLikeEduitFlowFormReply,
  historyHasEduitFlowFormReply,
} from '../libShared/eduitFlowFormParse.js'
import {
  SUMARE_POLOS_EAD,
  resolvePoloUnidadeCode,
  buildPoloEscolhaPreFormMessage,
  buildPoloEscolhidoAckReply,
  buildPoloConfirmacaoInvalidaReply,
  matchPoloFromUserMessage,
  resolvePoloFromKommoSnapshot,
  extractPoloFromConversationHistory,
} from '../libShared/sumarePoloCatalog.js'
import {
  ensureDadosClienteRow,
  fetchDadosClienteByTelefone,
} from './dadosClienteStore.js'
import { createLeadAuditNote } from './kommoClient.js'
import { resolveCrmLeadId } from './crmAdapter.js'
import { resolveTransferenciaCursoCodigo, suggestSimilarTransferenciaCursos } from './sumareCaptacaoClient.js'
import { deliverInscricaoForm } from './inscricaoFormFlow.js'
import {
  executeCaptacaoAfterFormResolved,
  detectFormSumarRecebidoNoKommo,
} from './inscricaoPostFormPipeline.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { DADOS_CLIENTE_FORM_GUARD_SELECT } from './dadosClienteInscricaoFields.js'
import { gateMatriculaConfirmacaoBeforeForm } from './inscricaoMatriculaConfirmFlow.js'
import { syncSumPoloOnLeadQuiet } from './sumareLeadFields.js'
import {
  buildFacultyContactRedirectReply,
  replyLooksLikeFacultyContactRedirect,
} from '../libShared/humanHandoffHeuristics.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

function resolvePoloEntry(poloId) {
  if (!poloId) return null
  const id = String(poloId).trim().toLowerCase()
  return SUMARE_POLOS_EAD.find((p) => p.id === id) || matchPoloFromUserMessage(id)
}

async function resolveLeadId(env, telefone, hint) {
  return resolveCrmLeadId(env, telefone, hint)
}

/**
 * Resolve polo já gravado em Supabase ou no card Kommo (não força fallback).
 * @returns {{ poloNome: string, unidade: string, source: string } | null}
 */
async function resolveExistingPolo(env, { telefone, leadId, historyMessages = [] }) {
  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},polo_inscricao_escolhido,captacao_unidade`,
  )
  const poloNome = String(row?.polo_inscricao_escolhido || '').trim()
  const unidade = String(row?.captacao_unidade || '').trim()
  if (poloNome) {
    const matched = matchPoloFromUserMessage(poloNome)
    return {
      poloNome: matched?.nome || poloNome,
      unidade: unidade || (matched ? resolvePoloUnidadeCode(matched.id, env) : ''),
      source: 'supabase',
    }
  }
  const fromHistory = extractPoloFromConversationHistory(historyMessages)
  if (fromHistory) {
    return {
      poloNome: fromHistory.nome,
      unidade: resolvePoloUnidadeCode(fromHistory.id, env),
      source: 'history',
    }
  }
  if (leadId != null) {
    const snap = await fetchLeadFormSnapshot(env, leadId).catch(() => ({ ok: false }))
    if (snap.ok && snap.snapshot) {
      const resolved = resolvePoloFromKommoSnapshot(snap.snapshot, env)
      if (resolved) {
        return { poloNome: resolved.polo.nome, unidade: resolved.unidade, source: resolved.source }
      }
    }
  }
  return null
}

/**
 * Persiste polo/unidade SEM forçar `aguardando_form_sumar` — o status só é
 * gravado depois que `deliverInscricaoForm` confirma sucesso (Mario #24068327:
 * gravar o status antes do deliver fazia o próprio deliver enxergar
 * "já aguardando" e retornar FORM_ALREADY_SENT/skip no mesmo turno).
 */
async function gravarPoloEUnidade(env, { telefone, leadId, polo, unidade }) {
  const row = await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
    },
  })
  await syncSumPoloOnLeadQuiet(env, { leadId, telefone, poloNome: polo.nome })
  return row
}

async function gravarStatus(env, { telefone, leadId, status }) {
  return ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: { [FORM_STATUS_FIELD]: status },
  })
}

/** Códigos de falha REAL do deliver — mensagem de consultor é adequada. */
const FORM_DELIVERY_HARD_FAIL_CODES = new Set([
  'SALESBOT_FAILED',
  'MISSING_FORMULARIO_SUM_BOT_ID',
  'LEAD_NOT_FOUND',
])

/**
 * Deliver falhou/skippou por já ter sido enviado ou dedupe — não é falha
 * real, então a resposta deve ser suave (`buildFormAwaitingFillReply`), não
 * a mensagem de consultor.
 */
function isSoftFormDeliverySkip(delivery) {
  const code = delivery?.result?.code
  if (FORM_DELIVERY_HARD_FAIL_CODES.has(code)) return false
  if (code === 'FORM_ALREADY_SENT') return true
  if (code === 'dedupe_recent') return true
  if (delivery?.result?.reason === 'dedupe_recent') return true
  if (delivery?.result?.skipped === true) return true
  return false
}

/** Tool: `enviar_form_sumar_inscricao`. */
export async function runEnviarFormSumarInscricao(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const curso = String(args.curso || '').trim()
  const poloId = args.polo_id ? String(args.polo_id).trim().toLowerCase() : null
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'enviar_form_sumar_inscricao', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)

  const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
  if (shouldBlockFormularioSumResend(guardRow)) {
    const status = guardRow?.[FORM_STATUS_FIELD] ?? null
    const reply =
      status === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
        ? 'Já recebemos seu formulário e enviamos o link para concluir a matrícula. Se precisar do link de pagamento de novo, é só pedir por aqui.'
        : buildFormAwaitingFillReply({ pushName })
    return {
      ok: true,
      code: 'FORM_ALREADY_SENT',
      text: 'Formulário já enviado ou inscrição já avançou — não reativar Formulario_Sum.',
      replyOverride: reply,
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: status || 'blocked_resend',
        blockedResend: true,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: true, code: 'FORM_ALREADY_SENT' }],
    }
  }

  let polo = null
  let unidade = null
  if (poloId) {
    const entry = resolvePoloEntry(poloId)
    if (!entry) {
      const reply = buildPoloConfirmacaoInvalidaReply()
      await gravarStatus(env, { telefone, leadId, status: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM }).catch(() => {})
      return {
        ok: false,
        code: 'INVALID_POLO',
        text: `polo_id inválido: ${poloId}. Use sao_miguel | barra_funda | tatuape | santana | pinheiros.`,
        replyOverride: reply,
        ctxSnapshot: {
          inscricaoActionTool: 'enviar_form_sumar_inscricao',
          inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
          poloIdInformado: poloId,
        },
        steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'INVALID_POLO' }],
      }
    }
    polo = entry
    unidade = resolvePoloUnidadeCode(polo.id, env)
  } else {
    const existing = await resolveExistingPolo(env, {
      telefone,
      leadId,
      historyMessages: ctx.historyMessages || [],
    })
    if (existing) {
      const matched = matchPoloFromUserMessage(existing.poloNome)
      polo = matched || { id: 'supabase', nome: existing.poloNome, endereco: '' }
      unidade = existing.unidade
    }
  }

  if (!polo) {
    await gravarStatus(env, {
      telefone,
      leadId,
      status: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
    }).catch(() => {})
    const reply = buildPoloEscolhaPreFormMessage({ pushName })
    return {
      ok: false,
      code: 'POLO_NEEDED',
      text: 'Polo ainda não definido — pedi escolha de polo (1-5) ao lead. NÃO afirme que enviou o formulário.',
      replyOverride: reply,
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
        curso,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'POLO_NEEDED' }],
    }
  }

  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
    },
  }).catch(() => {})
  await syncSumPoloOnLeadQuiet(env, { leadId, telefone, poloNome: polo.nome })

  const matriculaGate = await gateMatriculaConfirmacaoBeforeForm(env, {
    telefone,
    userMessage: '',
    historyMessages: ctx.historyMessages || [],
    leadId,
    cursoHint: curso,
    executionId: ctx.executionId,
    model: ctx.model,
    pushName,
    t0: Date.now(),
  })
  if (!matriculaGate.proceed) {
    if (matriculaGate.handled) {
      const reply = matriculaGate.result?.reply || ''
      return {
        ok: true,
        code: 'MATRICULA_RESUMO_PENDING',
        text: 'Resumo de matrícula enviado — aguardar autorização do lead antes do formulário.',
        replyOverride: reply,
        ctxSnapshot: {
          inscricaoActionTool: 'enviar_form_sumar_inscricao',
          inscricaoForm: matriculaGate.result?.ctxSnapshot?.inscricaoForm,
          poloId: polo.id,
          unidade,
        },
        steps: [
          { type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: true, code: 'MATRICULA_RESUMO_PENDING' },
          ...(matriculaGate.result?.orchestratorSteps || []),
        ],
      }
    }
    return {
      ok: false,
      code: 'MATRICULA_AUTHORIZATION_PENDING',
      text: 'Lead ainda não autorizou o resumo de matrícula — não enviar formulário.',
      replyOverride:
        'Antes de seguir com o formulário, preciso da sua autorização sobre as condições da matrícula que enviei. Você autoriza a conclusão da matrícula?',
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: 'aguardando_autorizacao_matricula',
        poloId: polo.id,
      },
      steps: [{ type: 'tool_action', tool: 'enviar_form_sumar_inscricao', ok: false, code: 'MATRICULA_AUTHORIZATION_PENDING' }],
    }
  }

  await gravarPoloEUnidade(env, { telefone, leadId, polo, unidade }).catch(() => {})

  // Envio intencional neste turno: forceResend evita que o próprio deliver
  // veja um status "aguardando" (gravado por outra réplica/turno) e retorne
  // FORM_ALREADY_SENT/skip antes de sequer tentar o salesbot.
  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId,
    executionId: ctx.executionId,
    forceResend: true,
  })
  const sendOk = Boolean(delivery.result?.ok)

  if (!sendOk) {
    if (isSoftFormDeliverySkip(delivery)) {
      return {
        ok: true,
        code: delivery.result?.code || 'FORM_ALREADY_SENT',
        text: 'Formulário já enviado/skip de reenvio — resposta suave (não é falha real).',
        replyOverride: buildFormAwaitingFillReply({ pushName }),
        ctxSnapshot: {
          inscricaoActionTool: 'enviar_form_sumar_inscricao',
          inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
          delivery: delivery.delivery,
          poloId: polo.id,
          unidade,
          softSkip: true,
        },
        steps: [
          {
            type: 'tool_action',
            tool: 'enviar_form_sumar_inscricao',
            ok: true,
            code: delivery.result?.code || 'FORM_ALREADY_SENT',
            delivery: delivery.delivery,
          },
        ],
      }
    }
    return {
      ok: false,
      code: delivery.result?.code || 'FORM_SEND_FAILED',
      text: `Falha ao disparar Form Sumar: ${delivery.result?.error || delivery.result?.code || 'erro'}.`,
      replyOverride: buildFacultyContactRedirectReply({ pushName }),
      ctxSnapshot: {
        inscricaoActionTool: 'enviar_form_sumar_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
        delivery: delivery.delivery,
        poloId: polo.id,
        unidade,
        error: delivery.result?.error,
      },
      steps: [
        {
          type: 'tool_action',
          tool: 'enviar_form_sumar_inscricao',
          ok: false,
          code: delivery.result?.code || 'FORM_SEND_FAILED',
          delivery: delivery.delivery,
        },
      ],
    }
  }

  await gravarStatus(env, { telefone, leadId, status: INSCRICAO_FORM_STATUS_AGUARDANDO }).catch(() => {})

  const reply = buildInscricaoFormSentReply({ pushName, resend: false })
  return {
    ok: true,
    code: 'FORM_SENT_OK',
    text: `Form Sumar disparado (delivery=${delivery.delivery}). Estado: ${INSCRICAO_FORM_STATUS_AGUARDANDO}.`,
    replyOverride: reply,
    ctxSnapshot: {
      inscricaoActionTool: 'enviar_form_sumar_inscricao',
      inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
      delivery: delivery.delivery,
      poloId: polo.id,
      poloNome: polo.nome,
      unidade,
      curso,
    },
    steps: [
      {
        type: 'tool_action',
        tool: 'enviar_form_sumar_inscricao',
        ok: true,
        delivery: delivery.delivery,
        bot_id: delivery.result?.botId,
        polo: polo.id,
      },
    ],
  }
}

/**
 * Formulário/captação já existem — reprocessa API Captação como Transferencia_Ext.
 */
async function runTransferenciaRecaptacaoPosForm(
  env,
  ctx,
  { origemDesc, destinoDesc, semestre, origemCodigo, destinoCodigo },
) {
  const telefone = String(ctx.telefone || '').trim()
  const leadId = await resolveLeadId(env, telefone, ctx.leadId)
  const executionId = ctx.executionId || `transferencia-${Date.now()}`
  const pushName = ctx.pushName

  const cap = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead: leadId,
    executionId,
    pushName,
    confirmedNovaInscricao: true,
  })

  const nameBit = pushName ? `, ${String(pushName).split(/\s+/)[0]}` : ''
  const semestreBit = semestre ? ` (último semestre concluído: ${semestre})` : ''
  const origemBit = origemDesc || 'seu curso anterior'
  const destinoBit = destinoDesc || 'o curso desejado'

  let replyOverride =
    `Perfeito${nameBit}! Registramos sua *transferência externa* de ${origemBit}${semestreBit} ` +
    `para ${destinoBit} na Faculdade Sumaré. Nossa equipe acadêmica vai analisar o aproveitamento de disciplinas.\n\n`

  // Nunca concatenar o redirect de falha da faculdade após o sucesso da
  // transferência (Diego #24127679). Só anexa reply de captação "útil".
  const capReply = String(cap.reply || '').trim()
  const capReplyUsable =
    Boolean(capReply) && !replyLooksLikeFacultyContactRedirect(capReply)

  if (cap.ok && capReplyUsable) {
    replyOverride += capReply
  } else if (cap.code === 'NEEDS_CONFIRM_NOVA_INSCRICAO' && capReplyUsable) {
    replyOverride += capReply
  } else {
    replyOverride +=
      'Em instantes enviamos por aqui o link atualizado para conclusão da matrícula. Qualquer dúvida, estamos à disposição.'
  }

  if (leadId) {
    await createLeadAuditNote(
      env,
      leadId,
      `Transferência externa registrada: ${origemCodigo || origemBit} → ${destinoCodigo || destinoBit}, ` +
        `semestre ${semestre || 'n/a'}. Captação reprocessada como Transferencia_Ext.`,
    ).catch(() => {})
  }

  return {
    ok: Boolean(cap.ok),
    code: cap.ok ? 'TRANSFERENCIA_RECAPTACAO_OK' : cap.code || 'TRANSFERENCIA_RECAPTACAO_FAIL',
    text: 'Transferência registrada; captação reprocessada.',
    replyOverride,
    ctxSnapshot: {
      inscricaoActionTool: 'registrar_transferencia',
      inscricaoForm: cap.ctxForm || INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
      transferenciaRecaptacao: true,
      transferenciaOrigem: origemCodigo,
      transferenciaDestino: destinoCodigo,
      transferenciaSemestre: semestre,
    },
    steps: [
      {
        type: 'tool_action',
        tool: 'registrar_transferencia',
        ok: Boolean(cap.ok),
        code: 'TRANSFERENCIA_RECAPTACAO',
      },
      ...(cap.steps || []),
    ],
  }
}

/**
 * Tool: `registrar_transferencia`.
 * Ingresso por transferência externa / aproveitamento de matérias: grava os 3
 * campos extras (curso de origem, semestre concluído, curso desejado) e segue
 * para o mesmo fluxo de polo + Form Sumar do vestibular. A geração na API
 * Captação usa tipoIngresso=Transferencia_Ext (montado no pós-formulário).
 */
export async function runRegistrarTransferencia(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const cursoOrigemRaw = String(args.curso_origem || '').trim()
  const semestreRaw = String(args.semestre_concluido || '').trim()
  const cursoDesejadoRaw = String(args.curso_desejado || '').trim()
  const poloId = args.polo_id ? String(args.polo_id).trim().toLowerCase() : null
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const historyBlob = (ctx.historyMessages || [])
    .map((m) => String(m?.content || ''))
    .join('\n')
  const hasTransferEvidence =
    /outra\s+faculdade|transfer[eê]ncia|aproveitamento|parou\s+no|tranquei|parei\s+no|terminei\s+no|cursava|cursando\s+.+\s+em\s+outr|comecei\s+.+\s+em\s+outra/i.test(
      historyBlob,
    ) || /aproveitamento\s+de\s+(mat[eé]rias|disciplinas)/i.test(historyBlob)
  if ((ctx.historyMessages || []).length > 0 && !hasTransferEvidence) {
    return {
      ok: false,
      code: 'TRANSFERENCIA_SEM_EVIDENCIA',
      text: 'Histórico sem evidência de transferência/aproveitamento — tool ignorada.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', error: 'sem_evidencia' },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'TRANSFERENCIA_SEM_EVIDENCIA' }],
    }
  }

  const faltando = []
  if (!cursoOrigemRaw) faltando.push('curso de origem (o que você cursou/cursa)')
  if (!semestreRaw) faltando.push('último semestre concluído')
  if (!cursoDesejadoRaw) faltando.push('curso desejado na Sumaré')
  if (faltando.length) {
    return {
      ok: false,
      code: 'TRANSFERENCIA_DADOS_FALTANDO',
      text: `Faltam dados da transferência: ${faltando.join(', ')}. Pergunte ao lead.`,
      replyOverride: `Para dar entrada pela transferência/aproveitamento de matérias, me confirme: ${faltando.join(', ')}.`,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', faltando },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'TRANSFERENCIA_DADOS_FALTANDO' }],
    }
  }

  const [origem, destino] = await Promise.all([
    resolveTransferenciaCursoCodigo(env, cursoOrigemRaw),
    resolveTransferenciaCursoCodigo(env, cursoDesejadoRaw),
  ])

  if (!destino) {
    const sugestoes = await suggestSimilarTransferenciaCursos(env, cursoDesejadoRaw, 4)
    const lista =
      sugestoes.length > 0
        ? `\n\nCursos parecidos na Sumaré EAD:\n${sugestoes.map((s) => `• ${s.descricao}`).join('\n')}\n\nQual deles você quer cursar?`
        : '\n\nPode confirmar o nome exato do curso EAD que você quer cursar na Sumaré?'
    return {
      ok: false,
      code: 'CURSO_DESTINO_INVALIDO',
      text: `Curso desejado "${cursoDesejadoRaw}" não encontrado na lista EAD oficial. Peça o nome correto do curso.`,
      replyOverride: `Não localizei o curso "${cursoDesejadoRaw}" na nossa lista EAD.${lista}`,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', cursoDesejadoRaw, sugestoes: sugestoes.map((s) => s.descricao) },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'CURSO_DESTINO_INVALIDO' }],
    }
  }
  if (!origem) {
    return {
      ok: false,
      code: 'CURSO_ORIGEM_INVALIDO',
      text: `Curso de origem "${cursoOrigemRaw}" não bateu com a lista EAD oficial. Confirme o nome do curso anterior.`,
      replyOverride: `Só pra confirmar: qual era exatamente o nome do curso que você cursou/está cursando? Não consegui identificar "${cursoOrigemRaw}".`,
      ctxSnapshot: { inscricaoActionTool: 'registrar_transferencia', cursoOrigemRaw },
      steps: [{ type: 'tool_action', tool: 'registrar_transferencia', ok: false, code: 'CURSO_ORIGEM_INVALIDO' }],
    }
  }

  const semestre = semestreRaw.replace(/\D/g, '')
  const leadId = await resolveLeadId(env, telefone, ctx.leadId)

  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      transferencia_curso_origem: origem.codigo,
      transferencia_semestre: semestre || semestreRaw,
      transferencia_curso_destino: destino.codigo,
    },
  }).catch(() => {})

  const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
  if (shouldBlockFormularioSumResend(guardRow)) {
    return runTransferenciaRecaptacaoPosForm(env, ctx, {
      origemDesc: origem.descricao,
      destinoDesc: destino.descricao,
      semestre: semestre || semestreRaw,
      origemCodigo: origem.codigo,
      destinoCodigo: destino.codigo,
    })
  }

  // Mesmo fluxo do vestibular: pede polo (se preciso), gate de matrícula e Form Sumar.
  // O pós-formulário lê as colunas de transferência e gera com Transferencia_Ext.
  return runEnviarFormSumarInscricao(
    env,
    { telefone, curso: destino.descricao, polo_id: poloId },
    ctx,
  )
}

/** Tool: `registrar_polo_inscricao`. */
export async function runRegistrarPoloInscricao(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const poloId = String(args.polo_id || '').trim().toLowerCase()
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'registrar_polo_inscricao', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const polo = resolvePoloEntry(poloId)
  if (!polo) {
    return {
      ok: false,
      code: 'INVALID_POLO',
      text: `polo_id inválido: "${poloId}". Use sao_miguel | barra_funda | tatuape | santana | pinheiros.`,
      replyOverride: buildPoloConfirmacaoInvalidaReply(),
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
        poloIdInformado: poloId,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'INVALID_POLO' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)
  const unidade = resolvePoloUnidadeCode(polo.id, env)

  const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
  if (shouldBlockFormularioSumResend(guardRow)) {
    return {
      ok: true,
      code: 'FORM_ALREADY_SENT',
      text: 'Polo reconhecido, mas formulário já foi enviado — não reativar Formulario_Sum.',
      replyOverride: buildFormAwaitingFillReply({ pushName }),
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: guardRow?.[FORM_STATUS_FIELD] || 'blocked_resend',
        poloId: polo.id,
        blockedResend: true,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: true, code: 'FORM_ALREADY_SENT' }],
    }
  }

  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadId,
    fields: {
      polo_inscricao_escolhido: polo.nome,
      captacao_unidade: unidade,
    },
  }).catch(() => {})
  await syncSumPoloOnLeadQuiet(env, { leadId, telefone, poloNome: polo.nome })

  // Transferência: o polo chega em um turno separado do registrar_transferencia,
  // então o curso desejado (destino) não está na conversa deste turno — e o lead
  // citou DOIS cursos (origem + destino), o que confunde a heurística do resumo.
  // Resolvemos o nome humano do destino persistido p/ usar como cursoHint e o
  // resumo de matrícula mostrar o curso CERTO (o que o lead vai cursar na Sumaré).
  let cursoHint
  try {
    const transfRow = await fetchDadosClienteByTelefone(env, telefone, 'transferencia_curso_destino')
    if (transfRow?.transferencia_curso_destino) {
      const dest = await resolveTransferenciaCursoCodigo(env, transfRow.transferencia_curso_destino)
      cursoHint = dest?.descricao || undefined
    }
  } catch {
    /* sem hint: gate cai na heurística da conversa (fluxo vestibular normal) */
  }

  const matriculaGate = await gateMatriculaConfirmacaoBeforeForm(env, {
    telefone,
    userMessage: String(args.polo_id || ''),
    historyMessages: ctx.historyMessages || [],
    leadId,
    cursoHint,
    executionId: ctx.executionId,
    model: ctx.model,
    pushName,
    t0: Date.now(),
  })
  if (!matriculaGate.proceed) {
    if (matriculaGate.handled) {
      const reply = matriculaGate.result?.reply || ''
      return {
        ok: true,
        code: 'MATRICULA_RESUMO_PENDING',
        text: 'Polo registrado; resumo de matrícula enviado — aguardar autorização antes do formulário.',
        replyOverride: reply,
        ctxSnapshot: {
          inscricaoActionTool: 'registrar_polo_inscricao',
          inscricaoForm: matriculaGate.result?.ctxSnapshot?.inscricaoForm,
          poloId: polo.id,
          unidade,
        },
        steps: [
          { type: 'tool_action', tool: 'registrar_polo_inscricao', ok: true, code: 'MATRICULA_RESUMO_PENDING' },
          ...(matriculaGate.result?.orchestratorSteps || []),
        ],
      }
    }
    return {
      ok: false,
      code: 'MATRICULA_AUTHORIZATION_PENDING',
      text: 'Lead ainda não autorizou o resumo de matrícula — não enviar formulário.',
      replyOverride:
        'Antes de seguir com o formulário, preciso da sua autorização sobre as condições da matrícula que enviei. Você autoriza a conclusão da matrícula?',
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: 'aguardando_autorizacao_matricula',
        poloId: polo.id,
      },
      steps: [{ type: 'tool_action', tool: 'registrar_polo_inscricao', ok: false, code: 'MATRICULA_AUTHORIZATION_PENDING' }],
    }
  }

  await gravarPoloEUnidade(env, { telefone, leadId, polo, unidade }).catch(() => {})

  // Nova escolha de polo = envio intencional do Form Sumar neste turno.
  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId,
    executionId: ctx.executionId,
    forceResend: true,
  })
  const sendOk = Boolean(delivery.result?.ok)

  if (!sendOk) {
    if (isSoftFormDeliverySkip(delivery)) {
      return {
        ok: true,
        code: delivery.result?.code || 'FORM_ALREADY_SENT',
        text: `Polo ${polo.nome} gravado; formulário já enviado/skip de reenvio — resposta suave.`,
        replyOverride: buildFormAwaitingFillReply({ pushName }),
        ctxSnapshot: {
          inscricaoActionTool: 'registrar_polo_inscricao',
          inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
          poloId: polo.id,
          poloNome: polo.nome,
          unidade,
          delivery: delivery.delivery,
          softSkip: true,
        },
        steps: [
          {
            type: 'tool_action',
            tool: 'registrar_polo_inscricao',
            ok: true,
            code: delivery.result?.code || 'FORM_ALREADY_SENT',
            polo: polo.id,
          },
        ],
      }
    }
    return {
      ok: false,
      code: delivery.result?.code || 'FORM_SEND_FAILED',
      text: `Polo ${polo.nome} gravado, mas falha ao disparar Form Sumar: ${delivery.result?.error || delivery.result?.code || 'erro'}.`,
      replyOverride: buildFacultyContactRedirectReply({ pushName }),
      ctxSnapshot: {
        inscricaoActionTool: 'registrar_polo_inscricao',
        inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
        poloId: polo.id,
        poloNome: polo.nome,
        unidade,
        delivery: delivery.delivery,
        error: delivery.result?.error,
      },
      steps: [
        {
          type: 'tool_action',
          tool: 'registrar_polo_inscricao',
          ok: false,
          code: delivery.result?.code || 'FORM_SEND_FAILED',
          polo: polo.id,
        },
      ],
    }
  }

  await gravarStatus(env, { telefone, leadId, status: INSCRICAO_FORM_STATUS_AGUARDANDO }).catch(() => {})

  const reply = buildPoloEscolhidoAckReply(polo, { pushName })
  return {
    ok: true,
    code: 'POLO_REGISTRADO_OK',
    text: `Polo ${polo.nome} (${unidade}) gravado e Form Sumar disparado (delivery=${delivery.delivery}). Estado: ${INSCRICAO_FORM_STATUS_AGUARDANDO}.`,
    replyOverride: reply,
    ctxSnapshot: {
      inscricaoActionTool: 'registrar_polo_inscricao',
      inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO,
      poloId: polo.id,
      poloNome: polo.nome,
      unidade,
      delivery: delivery.delivery,
    },
    steps: [
      {
        type: 'tool_action',
        tool: 'registrar_polo_inscricao',
        ok: true,
        polo: polo.id,
        unidade,
        delivery: delivery.delivery,
        bot_id: delivery.result?.botId,
      },
    ],
  }
}

/** Tool: `confirmar_recebimento_formulario`. */
export async function runConfirmarRecebimentoFormulario(env, args = {}, ctx = {}) {
  const telefone = String(args.telefone || ctx.telefone || '').trim()
  const pushName = ctx.pushName

  if (!telefone) {
    return {
      ok: false,
      code: 'MISSING_TELEFONE',
      text: 'Falha: telefone não informado.',
      replyOverride: null,
      ctxSnapshot: { inscricaoActionTool: 'confirmar_recebimento_formulario', error: 'missing_telefone' },
      steps: [{ type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'MISSING_TELEFONE' }],
    }
  }

  const leadId = await resolveLeadId(env, telefone, ctx.leadId)
  if (leadId == null) {
    return {
      ok: false,
      code: 'LEAD_NOT_FOUND',
      text: 'Não consegui localizar o lead no Kommo para concluir a inscrição.',
      replyOverride: buildFacultyContactRedirectReply({ pushName }),
      ctxSnapshot: { inscricaoActionTool: 'confirmar_recebimento_formulario', leadNotFound: true },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'LEAD_NOT_FOUND' },
      ],
    }
  }

  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},polo_inscricao_escolhido,captacao_unidade,captacao_candidato_id,inscricao_form_recebido_at`,
  )
  const status = row?.[FORM_STATUS_FIELD] ?? null
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO || row?.captacao_candidato_id) {
    return {
      ok: true,
      code: 'ALREADY_PROCESSED',
      text: `Inscrição já processada (status=${status || 'concluido'}). Não dispare de novo.`,
      replyOverride:
        'Já recebemos seu formulário e iniciamos sua inscrição. Em breve nossa equipe segue com você por aqui para finalizar, tudo bem?',
      ctxSnapshot: {
        inscricaoActionTool: 'confirmar_recebimento_formulario',
        inscricaoForm: status || 'concluido',
        alreadyProcessed: true,
      },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: true, code: 'ALREADY_PROCESSED' },
      ],
    }
  }

  // Lead afirmou ter enviado o formulário (é por isso que esta tool foi
  // chamada) — antes de disparar captação, confirma no Kommo/DB que o form
  // REALMENTE chegou. Sem confirmação: avisa e reenvia (forceResend), sem
  // acionar captação. Evita matricular/captar com dados vazios.
  const waitingForForm =
    status === INSCRICAO_FORM_STATUS_AGUARDANDO || status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
  if (waitingForForm && !inscricaoFormAlreadyFilled(row)) {
    const detect = await detectFormSumarRecebidoNoKommo(env, leadId).catch(() => ({ detected: false }))
    const inboundLooksLikeFlow =
      messageLooksLikeEduitFlowFormReply(ctx.userMessage) ||
      historyHasEduitFlowFormReply(ctx.historyMessages || [])
    if (!detect.detected && !inboundLooksLikeFlow) {
      console.log(
        `[inscricaoAction] lead=${leadId} confirmar_recebimento claim_sem_confirmacao_kommo status=${status} — reenviando Formulario_Sum`,
      )
      const delivery = await deliverInscricaoForm(env, {
        telefone,
        leadId,
        executionId: ctx.executionId,
        forceResend: true,
      })
      const sendOk = Boolean(delivery.result?.ok)
      if (sendOk) {
        await gravarStatus(env, { telefone, leadId, status: INSCRICAO_FORM_STATUS_AGUARDANDO }).catch(() => {})
      }
      return {
        ok: sendOk,
        code: 'FORM_NOT_RECEIVED_RESENT',
        text: `Lead afirmou ter enviado o formulário, mas não foi detectado no Kommo. Reenviado (ok=${sendOk}).`,
        replyOverride: buildFormNotReceivedResendReply({ pushName }),
        ctxSnapshot: {
          inscricaoActionTool: 'confirmar_recebimento_formulario',
          inscricaoForm: sendOk ? INSCRICAO_FORM_STATUS_AGUARDANDO : status,
          formNotReceivedResent: true,
          delivery: delivery.delivery,
        },
        steps: [
          {
            type: 'tool_action',
            tool: 'confirmar_recebimento_formulario',
            ok: sendOk,
            code: 'FORM_NOT_RECEIVED_RESENT',
            delivery: delivery.delivery,
          },
        ],
      }
    }
  }

  let snapshotOverride = null
  const unidadeDb = String(row?.captacao_unidade || '').trim()
  const poloDb = String(row?.polo_inscricao_escolhido || '').trim()
  if (unidadeDb && poloDb) {
    const snapRes = await fetchLeadFormSnapshot(env, leadId).catch(() => ({ ok: false }))
    const snapshot = snapRes.ok ? { ...snapRes.snapshot } : {}
    snapshot.unidade = unidadeDb
    snapshot.polo_inscricao = poloDb
    snapshotOverride = snapshot
  }

  const cap = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead: leadId,
    executionId: ctx.executionId,
    model: ctx.model,
    pushName,
    t0: ctx.t0 || Date.now(),
    snapshotOverride,
    confirmedNovaInscricao: Boolean(ctx.confirmedNovaInscricao),
    useCandidatoId: ctx.useCandidatoId,
  })

  if (cap.ok) {
    return {
      ok: true,
      code: 'INSCRICAO_REGISTRADA_OK',
      text: `Inscrição na API Sumaré OK. Estado: ${cap.ctxForm}.`,
      replyOverride: cap.reply,
      ctxSnapshot: {
        inscricaoActionTool: 'confirmar_recebimento_formulario',
        inscricaoForm: cap.ctxForm,
        sumareCaptacao: true,
        contratoWhatsappSent: Boolean(cap.contratoWhatsappSent),
        skipSchedulerWhatsapp: Boolean(cap.skipSchedulerWhatsapp),
      },
      steps: [
        { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: true, code: 'INSCRICAO_REGISTRADA_OK' },
        ...(cap.steps || []),
      ],
      toolCalls: cap.toolCalls || [],
    }
  }

  return {
    ok: false,
    code: 'CAPTACAO_FAILED',
    text: 'Falha ao registrar inscrição na API Sumaré. Reply servidor já trata o fallback.',
    replyOverride: cap.reply,
    ctxSnapshot: {
      inscricaoActionTool: 'confirmar_recebimento_formulario',
      inscricaoForm: cap.ctxForm,
      captacaoFailed: true,
    },
    steps: [
      { type: 'tool_action', tool: 'confirmar_recebimento_formulario', ok: false, code: 'CAPTACAO_FAILED' },
      ...(cap.steps || []),
    ],
    toolCalls: cap.toolCalls || [],
  }
}
