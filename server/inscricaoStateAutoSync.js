/**
 * Auto-sync de `inscricao_form_status` a partir do REPLY final do agente.
 *
 * Motivação (caso real lead #23841399):
 *   1. Lead manda "matricula".
 *   2. LLM orquestrador devolve, por conta própria, o texto canônico
 *      "em qual polo você prefere..." (a lista dos 5 polos está no prompt).
 *      Não chama tool nenhuma — apenas responde.
 *   3. Resultado: `inscricao_form_status` permanece NULL no Supabase.
 *   4. Lead responde "5".
 *   5. `tryHandlePoloPreFormFlow` precisa de `status === AGUARDANDO_POLO_PRE_FORM`
 *      OU `assistantAskedPoloPreFormChoice(lastAssist)` para true.
 *      Se o histórico veio vazio (race, falha de gravação, reset, TTL), nada
 *      funciona — a "5" cai no LLM sem contexto e o agente fica em silêncio.
 *
 * Este módulo é o **state mirror obrigatório**: sempre que o REPLY final do
 * agente contiver um texto canônico de uma transição de estado, gravamos esse
 * estado no Supabase ANTES de enviar a resposta ao lead. Assim, o próximo
 * turno passa a depender exclusivamente do estado persistido — e não mais do
 * histórico (que é frágil).
 *
 * Mantém-se idempotente: se já está no mesmo estado, NÃO regrava.
 * Mantém-se conservador: não rebaixa estados terminais (aceite/comprovante).
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA,
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
  INSCRICAO_FORM_STATUS_PROBLEMA_MAT,
} from '../libShared/inscricaoFormHeuristics.js'
import { assistantAskedPoloPreFormChoice } from '../libShared/sumarePoloCatalog.js'
import { assistantAskedDesistenciaConfirm } from '../libShared/inscricaoDesistenciaHeuristics.js'
import { ensureDadosClienteRow, updateDadosCliente } from './dadosClienteStore.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

/** Estados que NÃO devem ser sobrescritos por sinal do reply (o lead já avançou). */
const TERMINAL_OR_ADVANCED_STAGES = new Set([
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
  INSCRICAO_FORM_STATUS_PROBLEMA_MAT,
])

/**
 * Detecta a transição de estado pretendida pelo REPLY do agente.
 *
 * Retorna `null` quando o reply não corresponde a nenhuma transição canônica.
 *
 * @param {string} reply
 * @returns {string|null}
 */
export function detectStateFromReply(reply) {
  const text = String(reply || '').trim()
  if (!text) return null
  if (assistantAskedPoloPreFormChoice(text)) {
    return INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM
  }
  if (assistantAskedDesistenciaConfirm(text)) {
    return INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA
  }
  return null
}

/**
 * Sincroniza `inscricao_form_status` quando o reply final do agente sinaliza
 * uma transição canônica de estado mas o estado atual não reflete isso.
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.telefone
 * @param {number|string|null} [params.leadId]
 * @param {string} params.reply           texto final que será enviado ao lead
 * @param {string|null} [params.currentStage]   inscricao_form_status atual (se já lido)
 * @param {string} [params.executionId]
 * @returns {Promise<{ synced: boolean, signal?: string, target?: string|null, previous?: string|null, reason?: string }>}
 */
export async function autoSyncInscricaoStateFromReply(env, params = {}) {
  const { telefone, leadId = null, reply, currentStage = null, executionId = 'autoSync' } = params

  if (!telefone) return { synced: false, reason: 'no_telefone' }
  if (!reply || !String(reply).trim()) return { synced: false, reason: 'empty_reply' }

  if (currentStage && TERMINAL_OR_ADVANCED_STAGES.has(currentStage)) {
    return { synced: false, reason: 'terminal_or_advanced_stage', previous: currentStage }
  }

  const target = detectStateFromReply(reply)
  if (!target) return { synced: false, reason: 'no_canonical_signal' }

  if (currentStage === target) {
    return { synced: false, reason: 'already_in_target', previous: currentStage, target }
  }

  try {
    await ensureDadosClienteRow(env, {
      telefone,
      idLead: leadId,
      fields: { [FORM_STATUS_FIELD]: target },
    }).catch(() => {})

    const upd = await updateDadosCliente(env, {
      telefone,
      fields: { [FORM_STATUS_FIELD]: target },
    })

    const ok = Boolean(upd?.ok)
    const matched = Boolean(upd?.matched)
    console.log(
      `[${executionId}] INSCRICAO_STATE_AUTO_SYNC signal=polo_choice_question ` +
        `stage_before=${currentStage || 'null'} -> ${target} ok=${ok} matched=${matched} ` +
        `lead=${leadId ?? 'n/a'}`,
    )
    return {
      synced: ok && matched,
      signal: 'polo_choice_question',
      target,
      previous: currentStage,
    }
  } catch (err) {
    console.warn(
      `[${executionId}] INSCRICAO_STATE_AUTO_SYNC erro: ${err?.message || err}`,
    )
    return { synced: false, reason: 'update_error', error: String(err?.message || err) }
  }
}

/** Para testes: lista os estados considerados terminais/avançados. */
export const AUTO_SYNC_TERMINAL_OR_ADVANCED = TERMINAL_OR_ADVANCED_STAGES
