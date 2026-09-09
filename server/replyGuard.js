/**
 * Output guard: valida o `reply` final antes de mandar pro lead.
 *
 * Princípio: o LLM NUNCA pode afirmar uma ação de inscrição (envio do
 * formulário, registro de polo, conclusão da matrícula) sem ter chamado
 * a tool correspondente neste turno. Se afirmar mesmo assim, o guard
 * substitui o texto por uma mensagem segura do servidor.
 *
 * Plugar antes do whatsappSender:
 *
 *   const verdict = validateReplyAgainstActions({ reply, toolCalls, stage })
 *   if (verdict.violation) {
 *     reply = verdict.safeReply
 *     telemetry.guard_violation = verdict.code
 *   }
 */

import { buildPoloEscolhaPreFormMessage } from '../libShared/sumarePoloCatalog.js'
import {
  buildAcademicAffairsRedirectReply,
  buildPresencialClassDaysRedirectReply,
  messageAsksAcademicAffairsSupport,
  messageAsksPresencialClassDays,
} from '../libShared/academicAffairsHeuristics.js'
import {
  DEFAULT_LGPD_SENSITIVE_REFUSAL,
  lgpdGuardEnabled,
  replyLeaksSensitiveCandidateData,
  userMessageIsInstitutionalCourseInquiry,
  HARD_LGPD_LEAK_CODES,
} from '../libShared/lgpdCompliance.js'
import { sanitizeCourseLinksFromReply } from '../libShared/courseLinkOutboundGuard.js'
import { buildFacultyContactRedirectReply } from '../libShared/humanHandoffHeuristics.js'

const PROMISE_FORM_SEND_RX =
  /\b(enviei|acabei de enviar|j[aá] enviei|j[aá] ativei|vou enviar|vou mandar|pode aguardar|aguarde um momento|em instantes (vou|envio))\b[\s\S]{0,80}\bformul[aá]rio\b/i

const FORM_SENT_AFFIRMATION_RX =
  /\b(enviei|acabei de enviar|j[aá] enviei|j[aá] ativei)\b[\s\S]{0,80}\bformul[aá]rio\b/i

const POLO_REGISTERED_RX =
  /\b(polo|p[oó]lo)\b[\s\S]{0,40}\b(registrad[oa]|anotad[oa]|confirmad[oa]|salv[oa])\b/i

const INSCRICAO_DONE_RX =
  /\b(inscri[cç][aã]o|matr[ií]cula)\b[\s\S]{0,40}\b(registrada|concluid[ao]|iniciad[ao]|feita|finalizad[ao]|j[aá] foi feita|registrei)\b/i

const CAPTACAO_DONE_RX =
  /\b(cadastr(?:o|amos)|cadastrei|inscrev(?:i|emos)|registrei sua inscri[cç][aã]o)\b/i

const CONSULTOR_PROMISE_RX =
  /\b(consultor|atendente|equipe|nossa equipe)\b[\s\S]{0,80}\b(entrar[aá] em contato|vai te chamar|retornar|ligar|contato em breve)\b/i

/** Oferecer consultor como próximo passo — também é proibido. */
const CONSULTOR_OFFER_RX =
  /\b(verifique|verificar|passo|passar|encaminh|direcion|fale com|falar com)\b[\s\S]{0,70}\bconsultor\b|\bquer que eu verifique com um consultor\b|\bpassar pra um consultor\b|\bpassar para um consultor\b|\bcom um consultor os detalhes\b/i

const TRANSFERENCIA_REGISTER_RX =
  /\b(registr(?:ei|ar)|pedido de transfer[eê]ncia)\b/i

const ACADEMIC_CONSULTOR_RX =
  /\b(consultor|encaminhar|registrar\s+(o\s+)?seu\s+pedido|entrar[aá] em contato)\b/i

const ACTION_TOOL_NAMES = new Set([
  'enviar_form_sumar_inscricao',
  'registrar_polo_inscricao',
  'registrar_transferencia',
  'confirmar_recebimento_formulario',
])

function toolWasCalledOk(toolCalls, names) {
  const list = Array.isArray(toolCalls) ? toolCalls : []
  return list.some((tc) => {
    const name = tc?.tool || tc?.name || tc?.function?.name
    if (!name || !names.includes(name)) return false
    if (tc.ok === false) return false
    if (tc.actionOk === false) return false
    return true
  })
}

function safeReplyForStage(stage) {
  if (stage === 'aguardando_escolha_polo_pre_form') {
    return buildPoloEscolhaPreFormMessage({})
  }
  if (stage === 'aguardando_form_sumar' || stage === 'aguardando_distribuicao_form') {
    return (
      'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
    )
  }
  if (stage === 'aguardando_aceite_contrato') {
    return (
      'Sua inscrição já está registrada e enviei o link do contrato por aqui. Acesse o link, leia e clique em ASSINAR CONTRATO para concluir, tudo bem?'
    )
  }
  if (stage === 'form_sumar_concluido') {
    return (
      'Sua inscrição já está concluída por aqui. ' + buildFacultyContactRedirectReply({})
    )
  }
  // Sem stage definido → pede polo para começar o fluxo.
  return buildPoloEscolhaPreFormMessage({})
}

/**
 * @param {object} params
 * @param {string} params.reply         texto final do LLM (msg.content) prestes a ir pro lead
 * @param {Array}  params.toolCalls     toolTrace do turno (cada item tem `tool` + `ok`/`actionOk`)
 * @param {string} [params.stage]       inscricao_form_status atual (ou null)
 * @returns {{ violation: boolean, code?: string, safeReply?: string, original?: string }}
 */
export function validateReplyAgainstActions({ reply, toolCalls = [], stage = null } = {}) {
  const text = String(reply || '')
  if (!text || text.length < 4) return { violation: false }

  // Reply afirma que enviou o formulário?
  if (FORM_SENT_AFFIRMATION_RX.test(text) || PROMISE_FORM_SEND_RX.test(text)) {
    if (!toolWasCalledOk(toolCalls, ['enviar_form_sumar_inscricao', 'registrar_polo_inscricao'])) {
      return {
        violation: true,
        code: 'promise_form_send_without_tool',
        safeReply: safeReplyForStage(stage),
        original: text,
      }
    }
  }

  // Reply afirma que registrou polo?
  if (POLO_REGISTERED_RX.test(text)) {
    if (!toolWasCalledOk(toolCalls, ['registrar_polo_inscricao'])) {
      return {
        violation: true,
        code: 'polo_registered_without_tool',
        safeReply: safeReplyForStage(stage),
        original: text,
      }
    }
  }

  // Reply afirma que registrou inscrição/matrícula concluída?
  if (INSCRICAO_DONE_RX.test(text) || CAPTACAO_DONE_RX.test(text)) {
    if (!toolWasCalledOk(toolCalls, ['confirmar_recebimento_formulario'])) {
      return {
        violation: true,
        code: 'inscricao_done_without_tool',
        safeReply: safeReplyForStage(stage),
        original: text,
      }
    }
  }

  return { violation: false }
}

/**
 * Bloqueia promessa ou oferta de consultor. Não há consultor neste canal.
 */
export function validateReplyConsultorPromise({ reply, toolCalls = [], userMessage = '' } = {}) {
  const text = String(reply || '')
  if (!text || text.length < 8) return { violation: false }
  const offers = CONSULTOR_PROMISE_RX.test(text) || CONSULTOR_OFFER_RX.test(text)
  if (!offers) return { violation: false }
  void toolCalls
  if (TRANSFERENCIA_REGISTER_RX.test(text) && CONSULTOR_PROMISE_RX.test(text) && !CONSULTOR_OFFER_RX.test(text)) {
    return {
      violation: true,
      code: 'transferencia_consultor_without_tool',
      safeReply:
        'Vou seguir com sua transferência por aqui mesmo — só preciso confirmar o curso desejado na Sumaré e o último semestre concluído. Me confirma esses dados?',
      original: text,
    }
  }
  const safeReply = messageAsksPresencialClassDays(userMessage)
    ? buildPresencialClassDaysRedirectReply({})
    : buildFacultyContactRedirectReply({})
  return {
    violation: true,
    code: 'consultor_offer_or_promise',
    safeReply,
    original: text,
  }
}

/**
 * Bloqueia respostas que vazam dados sensíveis de candidatos (LGPD).
 * @param {object} params
 * @param {string} params.reply
 * @param {string} [params.userMessage]
 * @param {Record<string,string>} [params.env]
 */
export function validateReplyLgpd({ reply, userMessage = '', env = process.env } = {}) {
  if (!lgpdGuardEnabled(env)) return { violation: false }
  const text = String(reply || '')
  if (!text || text.length < 4) return { violation: false }
  const check = replyLeaksSensitiveCandidateData(text, { userMessage })
  if (!check.leak) return { violation: false }
  if (
    userMessageIsInstitutionalCourseInquiry(userMessage) &&
    !HARD_LGPD_LEAK_CODES.has(check.code)
  ) {
    return { violation: false }
  }
  return {
    violation: true,
    code: check.code,
    safeReply: DEFAULT_LGPD_SENSITIVE_REFUSAL,
    original: text,
  }
}

/**
 * Remove links de curso/site oficial da resposta (captação deve ser pelo canal).
 * @returns {{ violation: boolean, sanitized?: boolean, code?: string, safeReply?: string, original?: string, removed?: number }}
 */
export function sanitizeReplyCourseLinks({ reply } = {}) {
  const text = String(reply || '')
  if (!text || text.length < 4) return { violation: false }
  const { text: cleaned, removed } = sanitizeCourseLinksFromReply(text)
  if (removed === 0) return { violation: false }
  let safeReply = cleaned
  if (!safeReply || safeReply.length < 12) {
    safeReply =
      'Posso te passar todas as informações do curso por aqui mesmo. Se quiser seguir com a matrícula, é só me confirmar que te ajudo com o próximo passo.'
  }
  return {
    violation: true,
    sanitized: true,
    code: 'course_site_link_stripped',
    safeReply,
    original: text,
    removed,
  }
}

/** Valida guard de ações + links de curso + LGPD em sequência. */
export function validateReplyBeforeSend({ reply, toolCalls = [], stage = null, userMessage = '', env = process.env } = {}) {
  const actionVerdict = validateReplyAgainstActions({ reply, toolCalls, stage })
  if (actionVerdict.violation) return actionVerdict

  if (messageAsksAcademicAffairsSupport(userMessage)) {
    const text = String(reply || '')
    if (text.length > 8 && ACADEMIC_CONSULTOR_RX.test(text) && !text.includes('sumare.edu.br/atendimento')) {
      return {
        violation: true,
        code: 'academic_consultor_without_redirect',
        safeReply: buildAcademicAffairsRedirectReply({}),
        original: text,
      }
    }
  }

  const consultorVerdict = validateReplyConsultorPromise({ reply, toolCalls, userMessage })
  if (consultorVerdict.violation) return consultorVerdict

  let currentReply = reply
  const linkVerdict = sanitizeReplyCourseLinks({ reply: currentReply })
  if (linkVerdict.violation) currentReply = linkVerdict.safeReply

  const lgpdVerdict = validateReplyLgpd({ reply: currentReply, userMessage, env })
  if (lgpdVerdict.violation) return lgpdVerdict
  if (linkVerdict.violation) return linkVerdict

  return { violation: false }
}

/** Para testes/inspeção: lista as regex usadas. */
export const REPLY_GUARD_PATTERNS = {
  promiseFormSend: PROMISE_FORM_SEND_RX,
  formSentAffirmation: FORM_SENT_AFFIRMATION_RX,
  poloRegistered: POLO_REGISTERED_RX,
  inscricaoDone: INSCRICAO_DONE_RX,
  captacaoDone: CAPTACAO_DONE_RX,
}

export const REPLY_GUARD_ACTION_TOOL_NAMES = ACTION_TOOL_NAMES
