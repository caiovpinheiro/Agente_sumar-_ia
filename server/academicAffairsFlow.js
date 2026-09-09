/**
 * Assuntos acadêmicos (trancamento, cancelamento, ex-aluno, etc.) → resposta
 * canônica com Portal do Aluno / atendimento / ouvidoria. Sem consultor.
 * Pedido explícito de telefone institucional → número geral Pinheiros.
 */

import {
  messageAsksAcademicAffairsSupport,
  messageAsksInstitutionalAcademicPhone,
  messageAsksPresencialClassDays,
  messageAsksConsultantOnThisChannel,
  messageConfirmsConsultantOffer,
  buildAcademicAffairsRedirectReply,
  buildInstitutionalAcademicPhoneReply,
  buildPresencialClassDaysRedirectReply,
} from '../libShared/academicAffairsHeuristics.js'
import { buildFacultyContactRedirectReply } from '../libShared/humanHandoffHeuristics.js'

function buildAgentReturn({ executionId, model, t0, reply, steps, ctxSnapshot, ok = true }) {
  return {
    ok,
    reply,
    toolCalls: [],
    orchestratorSteps: steps || [],
    ctxSnapshot: ctxSnapshot || {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    academicAffairsHandled: true,
  }
}

export async function tryHandleAcademicAffairsInquiry(env, ctx = {}) {
  const { userMessage, historyMessages, executionId, model, pushName, t0 } = ctx

  if (messageAsksPresencialClassDays(userMessage)) {
    const reply = buildPresencialClassDaysRedirectReply({ pushName })
    console.log(
      `[${executionId}] PRESENCIAL_CLASS_DAYS_REDIRECT msg="${String(userMessage || '').slice(0, 80)}"`,
    )
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'presencial_class_days_redirect', preview: String(userMessage || '').slice(0, 120) }],
        ctxSnapshot: { presencialClassDaysRedirect: true },
      }),
    }
  }

  if (messageAsksInstitutionalAcademicPhone(userMessage, historyMessages)) {
    const reply = buildInstitutionalAcademicPhoneReply({ pushName })
    console.log(
      `[${executionId}] INSTITUTIONAL_ACADEMIC_PHONE msg="${String(userMessage || '').slice(0, 80)}"`,
    )
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'institutional_academic_phone', preview: String(userMessage || '').slice(0, 120) }],
        ctxSnapshot: { institutionalAcademicPhone: true },
      }),
    }
  }

  if (
    messageAsksConsultantOnThisChannel(userMessage) ||
    messageConfirmsConsultantOffer(userMessage, historyMessages)
  ) {
    const recentPresencial = (historyMessages || [])
      .concat([{ role: 'user', content: userMessage }])
      .some((m) => m?.role === 'user' && messageAsksPresencialClassDays(m.content))
    const reply = recentPresencial
      ? buildPresencialClassDaysRedirectReply({ pushName })
      : buildFacultyContactRedirectReply({ pushName })
    console.log(
      `[${executionId}] NO_CONSULTANT_OFFICIAL_LINKS msg="${String(userMessage || '').slice(0, 80)}"`,
    )
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'no_consultant_official_links', preview: String(userMessage || '').slice(0, 120) }],
        ctxSnapshot: { noConsultantOfficialLinks: true },
      }),
    }
  }

  if (!messageAsksAcademicAffairsSupport(userMessage, historyMessages)) return null

  const reply = buildAcademicAffairsRedirectReply({ pushName })
  console.log(`[${executionId}] ACADEMIC_AFFAIRS_REDIRECT msg="${String(userMessage || '').slice(0, 80)}"`)

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [{ type: 'academic_affairs_redirect', preview: String(userMessage || '').slice(0, 120) }],
      ctxSnapshot: { academicAffairsRedirect: true },
    }),
  }
}
