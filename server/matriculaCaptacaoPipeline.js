/**
 * Pós-formulário Kommo → API Captação Sumaré → WhatsApp com link do contrato.
 *
 * Acionado quando SUMARE_CAPTACAO_ENABLED=true e o formulário foi preenchido.
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  buildContratoAceiteLinkReply,
  buildSameCourseInProgressReply,
  buildConfirmNovaInscricaoReply,
} from '../libShared/inscricaoFormHeuristics.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { updateDadosCliente, normalizeTelefone, fetchDadosClienteByTelefone } from './dadosClienteStore.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { createLeadAuditNote } from './kommoClient.js'
import { moveLeadToAguardandoPagamentoIfNeeded } from './kommoFunnelMoves.js'
import {
  isSumareCaptacaoEnabled,
  runCaptacaoContratoWorkflow,
  consultarStatusCandidato,
  resolvePortalUrlForCandidato,
  extractCandidatoStatusString,
} from './sumareCaptacaoClient.js'
import { analyzeCursoInscricaoSnapshot } from '../libShared/captacaoSnapshotSanitize.js'
import { lookupCursoPrecoResumo, lookupRelatedCursoOfertas } from './inscricaoMatriculaConfirmFlow.js'

const DEDUPE_MS = 6 * 60 * 60 * 1000
const _linkSentMemory = new Map()

/**
 * Status do candidato na API Sumaré.
 * Se já "matriculado" / "aceite contrato" / "pagamento", não reenvia link.
 * Falha silenciosa (API fora) não bloqueia o fluxo.
 *
 * @returns {Promise<{ status: string|null, alreadyEnrolled: boolean }>}
 */
export async function fetchCandidatoStatus(env, candidatoId) {
  if (!candidatoId) return { status: null, alreadyEnrolled: false }
  try {
    const r = await consultarStatusCandidato(env, candidatoId)
    if (!r.ok) return { status: null, alreadyEnrolled: false }
    const raw = r.data?.status ?? r.data?.candidato?.status ?? null
    const status = raw ? String(raw).toLowerCase().trim() : null
    const alreadyEnrolled =
      !!status &&
      (status.includes('matricul') ||
        (status.includes('pagamento') && !status.includes('meio')))
    return { status, alreadyEnrolled }
  } catch {
    return { status: null, alreadyEnrolled: false }
  }
}

function shouldRunSalesbot49813(env) {
  return ['true', '1', 'yes'].includes(
    String(env.SUMARE_CAPTACAO_RUN_SALESBOT_49813 || 'false').trim().toLowerCase(),
  )
}

async function getCaptacaoDedupe(env, telefone) {
  const fone = normalizeTelefone(telefone)
  if (!fone) return { skip: false }
  const mem = _linkSentMemory.get(fone)
  if (mem && Date.now() - mem < DEDUPE_MS) {
    return { skip: true, reason: 'memory_dedupe' }
  }
  const { url, key, table } = {
    url: (env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente',
  }
  if (!url || !key) return { skip: false }
  try {
    const enc = encodeURIComponent(fone)
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?telefone=eq.${enc}&select=captacao_contrato_link_at,captacao_candidato_id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    if (!res.ok) return { skip: false }
    const rows = await res.json()
    const row = rows?.[0]
    if (row?.captacao_contrato_link_at) {
      const ts = Date.parse(row.captacao_contrato_link_at)
      if (!Number.isNaN(ts) && Date.now() - ts < DEDUPE_MS) {
        return { skip: true, reason: 'supabase_dedupe', candidatoId: row.captacao_candidato_id }
      }
    }
    // Mesmo fora da janela de 6h, se o candidato já tem ID Sumaré e está
    // matriculado/em aceite, NÃO regerar — apenas reportar como já tratado.
    if (row?.captacao_candidato_id) {
      const apiStatus = await fetchCandidatoStatus(env, row.captacao_candidato_id)
      if (apiStatus.alreadyEnrolled) {
        return {
          skip: true,
          reason: `api_status_${apiStatus.status || 'matriculado'}`,
          candidatoId: row.captacao_candidato_id,
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { skip: false }
}

async function persistCaptacaoResult(env, telefone, fieldsExtra = {}) {
  const fields = {
    captacao_contrato_link_at: new Date().toISOString(),
    inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
    inscricao_form_recebido_at: new Date().toISOString(),
    captacao_pending_candidato_id: null,
    ...fieldsExtra,
  }
  let upd = await updateDadosCliente(env, { telefone, fields })
  if (!upd.ok && upd.status === 400) {
    upd = await updateDadosCliente(env, {
      telefone,
      fields: {
        inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
        inscricao_form_recebido_at: new Date().toISOString(),
      },
    })
  }
  const fone = normalizeTelefone(telefone)
  if (fone) _linkSentMemory.set(fone, Date.now())
  return upd
}

/**
 * Executa inscrição Sumaré e envia link do contrato por WhatsApp.
 *
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reply?: string, contractUrl?: string, steps?: object[], error?: string }>}
 */
export async function runMatriculaCaptacaoAfterForm(env, ctx) {
  const { telefone, leadId, pushName, executionId } = ctx
  if (!isSumareCaptacaoEnabled(env)) {
    return { ok: false, skipped: true, reason: 'captacao_disabled' }
  }

  const dedupe = await getCaptacaoDedupe(env, telefone)
  if (dedupe.skip) {
    console.log(
      `[matriculaCaptacao] lead=${leadId} skip link (${dedupe.reason}) candidato=${dedupe.candidatoId || 'n/a'}`,
    )
    return { ok: true, skipped: true, reason: dedupe.reason }
  }

  const snapRes = await fetchLeadFormSnapshot(env, leadId)
  if (!snapRes.ok || !snapRes.snapshot) {
    return {
      ok: false,
      code: 'KOMMO_SNAPSHOT_FAILED',
      error: snapRes.error || 'Não foi possível ler dados do formulário no Kommo',
    }
  }

  const snapshot = {
    ...snapRes.snapshot,
    ...(ctx.snapshotOverride && typeof ctx.snapshotOverride === 'object' ? ctx.snapshotOverride : {}),
  }

  // Ingresso por transferência: os 3 campos extras (curso origem, série,
  // curso destino) ficam em dados_cliente_sum (gravados por registrar_transferencia)
  // e precisam entrar no snapshot p/ o `gerar` montar tipoIngresso=Transferencia_Ext.
  const transfRow = await fetchDadosClienteByTelefone(
    env,
    telefone,
    'transferencia_curso_origem,transferencia_semestre,transferencia_curso_destino',
  ).catch(() => null)
  if (transfRow?.transferencia_curso_origem) {
    snapshot.transferencia_curso_origem = transfRow.transferencia_curso_origem
    snapshot.transferencia_semestre = transfRow.transferencia_semestre
    if (!snapshot.tipo_inscricao || !/transfer/i.test(String(snapshot.tipo_inscricao))) {
      snapshot.tipo_inscricao = 'Transferência'
    }
    if (transfRow.transferencia_curso_destino) {
      snapshot.curso_inscricao = transfRow.transferencia_curso_destino
    }
  }

  const cursoCheck = await analyzeCursoInscricaoSnapshot(snapshot, env)
  if (!cursoCheck.ok) {
    console.warn(
      `[matriculaCaptacao] lead=${leadId} curso inválido: ${cursoCheck.code} ${cursoCheck.reason}`,
    )
    const cursoPedido = String(snapshot?.curso_inscricao || '').trim()
    const failure = {
      ok: false,
      code: cursoCheck.code,
      error: cursoCheck.reason,
      missing: cursoCheck.missing,
    }
    // Curso presente mas não resolvido/inválido: sugere alternativas oficiais.
    // CURSO_AUSENTE (vazio) NÃO busca alternativas — o lead ainda precisa informar o curso.
    if (
      cursoPedido &&
      (cursoCheck.code === 'CURSO_NAO_RESOLVIDO' || cursoCheck.code === 'CURSO_INVALIDO_SNAPSHOT')
    ) {
      const precoResumo = await lookupCursoPrecoResumo(env, cursoPedido).catch(() => null)
      if (precoResumo) {
        return {
          ok: false,
          code: 'CURSO_OFICIAL_SEM_CODIGO_CAPTACAO',
          error: `Curso "${cursoPedido}" existe no catálogo oficial, mas não tem código na API de captação`,
          missing: cursoCheck.missing,
          cursoPedido,
          precoResumo,
          alternativas: [],
        }
      }
      const alternativas = await lookupRelatedCursoOfertas(env, cursoPedido, { limit: 3 }).catch(
        () => [],
      )
      failure.cursoPedido = cursoPedido
      failure.alternativas = Array.isArray(alternativas) ? alternativas : []
    }
    return failure
  }

  let priorRow = await fetchDadosClienteByTelefone(
    env,
    telefone,
    'captacao_candidato_id,captacao_curso_codigo,captacao_curso_nome',
  )
  if (!priorRow) {
    priorRow = await fetchDadosClienteByTelefone(env, telefone, 'captacao_candidato_id')
  }

  const workflow = await runCaptacaoContratoWorkflow(env, {
    snapshot,
    telefone,
    captacaoContext: {
      priorCandidatoId: priorRow?.captacao_candidato_id,
      priorCursoCodigo: priorRow?.captacao_curso_codigo,
      priorCursoNome: priorRow?.captacao_curso_nome,
      confirmedNovaInscricao: Boolean(ctx.confirmedNovaInscricao),
      useCandidatoId: ctx.useCandidatoId,
    },
  })

  if (!workflow.ok && workflow.code === 'NEEDS_CONFIRM_NOVA_INSCRICAO') {
    const pendingId = workflow.candidatoId || null
    await persistCaptacaoResult(env, telefone, {
      captacao_candidato_id: String(workflow.priorCandidatoId || priorRow?.captacao_candidato_id || ''),
      captacao_curso_codigo: workflow.priorCursoCodigo || priorRow?.captacao_curso_codigo || null,
      captacao_curso_nome: workflow.priorCursoNome || priorRow?.captacao_curso_nome || null,
      captacao_pending_candidato_id: pendingId ? String(pendingId) : null,
      inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
      captacao_contrato_link: null,
    })
    const reply = buildConfirmNovaInscricaoReply({
      pushName,
      cursoNovo: workflow.requestedCurso?.nome || snapshot.curso_inscricao,
      cursoExistente: workflow.priorCursoNome || 'outro curso',
    })
    let sendRes = await sendMessageWithNote(env, { telefone, text: reply, leadId, executionId })
    if (!sendRes?.ok && !(sendRes?.skipped && sendRes?.deduped)) {
      await new Promise((r) => setTimeout(r, 1500))
      sendRes = await sendMessageWithNote(env, {
        telefone,
        text: reply,
        leadId,
        executionId: `${executionId || 'cap'}-retry`,
      })
    }
    return {
      ok: true,
      code: 'NEEDS_CONFIRM_NOVA_INSCRICAO',
      reply,
      whatsappOk: Boolean(sendRes?.ok && (sendRes.sent || 0) > 0),
      steps: workflow.steps,
    }
  }

  if (!workflow.ok) {
    console.warn(
      `[matriculaCaptacao] lead=${leadId} falha captacao: ${workflow.code} ${workflow.error}`,
    )
    return {
      ok: false,
      code: workflow.code,
      error: workflow.error,
      missing: workflow.missing,
      steps: workflow.steps,
    }
  }

  const { candidatoId, contractUrl, portalPhase, sameCourseInProgress, cursoCodigo, cursoNome } =
    workflow
  await persistCaptacaoResult(env, telefone, {
    captacao_candidato_id: String(candidatoId),
    captacao_contrato_link: contractUrl,
    captacao_curso_codigo: cursoCodigo || null,
    captacao_curso_nome: cursoNome || snapshot.curso_inscricao || null,
  })

  const reply = sameCourseInProgress
    ? buildSameCourseInProgressReply({
        pushName,
        contractUrl,
        cursoNome: cursoNome || snapshot.curso_inscricao,
      })
    : buildContratoAceiteLinkReply({ pushName, contractUrl, portalPhase })
  let sendRes = await sendMessageWithNote(env, {
    telefone,
    text: reply,
    leadId,
    executionId,
  })
  if (!sendRes?.ok && !(sendRes?.skipped && sendRes?.deduped)) {
    await new Promise((r) => setTimeout(r, 1500))
    sendRes = await sendMessageWithNote(env, {
      telefone,
      text: reply,
      leadId,
      executionId: `${executionId || 'cap'}-retry`,
    })
  }

  const whatsappOk = Boolean(sendRes?.ok && (sendRes.sent || 0) > 0)

  if (leadId) {
    const noteLine = whatsappOk
      ? `Inscrição Sumaré (candidato ${candidatoId}) — link contrato enviado por WhatsApp: ${contractUrl}`
      : `Inscrição Sumaré (candidato ${candidatoId}) — link contrato gerado (pendente envio WhatsApp): ${contractUrl}`
    await createLeadAuditNote(env, leadId, noteLine).catch(() => {})
    if (whatsappOk) {
      await moveLeadToAguardandoPagamentoIfNeeded(env, leadId, {
        reason: 'captacao_link_enviado',
      }).catch(() => {})
    }
  }

  console.log(
    `[matriculaCaptacao] lead=${leadId} candidato=${candidatoId} whatsapp_ok=${whatsappOk} url=${contractUrl.slice(0, 80)} err=${sendRes?.error || sendRes?.reason || 'n/a'}`,
  )

  return {
    ok: true,
    candidatoId,
    contractUrl,
    reply,
    whatsappOk,
    steps: workflow.steps,
    runSalesbot49813: shouldRunSalesbot49813(env),
  }
}

/**
 * Finaliza captação após lead confirmar nova inscrição (candidato já gerado).
 */
export async function finalizeCaptacaoForCandidato(env, ctx) {
  const { telefone, leadId, pushName, executionId, candidatoId, snapshot } = ctx
  const statusRes = await consultarStatusCandidato(env, candidatoId)
  const statusStr = extractCandidatoStatusString(statusRes.data)
  const portal = resolvePortalUrlForCandidato(env, candidatoId, statusStr, {
    cpf: snapshot?.cpf,
  })

  await persistCaptacaoResult(env, telefone, {
    captacao_candidato_id: String(candidatoId),
    captacao_contrato_link: portal.url,
    captacao_curso_codigo: ctx.cursoCodigo || null,
    captacao_curso_nome: ctx.cursoNome || snapshot?.curso_inscricao || null,
    captacao_pending_candidato_id: null,
    inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  })

  const sameCourseInProgress = portal.phase === 'pagamento'
  const reply = sameCourseInProgress
    ? buildSameCourseInProgressReply({
        pushName,
        contractUrl: portal.url,
        cursoNome: ctx.cursoNome || snapshot?.curso_inscricao,
      })
    : buildContratoAceiteLinkReply({
        pushName,
        contractUrl: portal.url,
        portalPhase: portal.phase,
      })

  const sendRes = await sendMessageWithNote(env, { telefone, text: reply, leadId, executionId })
  if (leadId) {
    if (sendRes?.ok && (sendRes.sent || 0) > 0) {
      await moveLeadToAguardandoPagamentoIfNeeded(env, leadId, {
        reason: 'captacao_finalize_nova_inscricao',
      }).catch(() => {})
    }
  }
  return { ok: true, reply, contractUrl: portal.url, whatsappOk: Boolean(sendRes?.ok && (sendRes.sent || 0) > 0) }
}

export { shouldRunSalesbot49813, INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE, INSCRICAO_FORM_STATUS_CONCLUIDO }
