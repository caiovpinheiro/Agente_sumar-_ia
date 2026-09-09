/**
 * Grava no card EduIT só os dados de cadastro que o lead informou e que ainda
 * estão vazios: nome, cpf, email, dtnascimento. Espelha kommo_* no Supabase.
 */

import { extractCadastroFieldsFromInbound, formatDataNascBr } from '../libShared/cadastroInboundExtract.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { isEduitBackend, resolveCrmLeadId } from './crmAdapter.js'
import { isEduitCuid, updateDealCustomFields } from './eduitClient.js'
import { updateDadosCliente } from './dadosClienteStore.js'
import { normalizeCpf } from './sumareCaptacaoClient.js'

export const EDUIT_FIELD_NOME = 'cmt4cvq7pgbviow01xqouo7ar'
export const EDUIT_FIELD_CPF = 'cmt4cw06hgbvsow011daujg7b'
export const EDUIT_FIELD_EMAIL = 'cmt4cxi5agbxqow01gvcdyory'
export const EDUIT_FIELD_DTNASCIMENTO = 'cmt4cwdhkgbvwow01vy7axvfp'

function isBlank(val) {
  const t = String(val ?? '').trim()
  if (!t) return true
  if (/^n[ãa]o informado\.?$/i.test(t)) return true
  if (/^n\/a$/i.test(t) || t === '-' || t === '—') return true
  return false
}

export function snapshotNeedsCpf(snapshot) {
  const raw = snapshot?.cpf
  if (isBlank(raw)) return true
  return !normalizeCpf(raw) || normalizeCpf(raw).length !== 11
}

export function snapshotNeedsEmail(snapshot) {
  const raw = String(snapshot?.email || '').trim()
  if (isBlank(raw)) return true
  return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
}

export function snapshotNeedsDataNasc(snapshot) {
  return isBlank(snapshot?.data_nasc)
}

function snapshotNeedsNome(snapshot) {
  const raw = String(snapshot?.nome || '').trim()
  if (isBlank(raw)) return true
  if (/^neg[oó]cio\b/i.test(raw)) return true
  if (!/\s/.test(raw)) return true
  return false
}

/**
 * @returns {Promise<{ ok: boolean, skipped?: boolean, written?: string[], code?: string }>}
 */
export async function persistCadastroFieldsFromInbound(env, input = {}) {
  const { telefone, userMessage, historyMessages, leadId } = input
  if (!telefone && !leadId) return { ok: false, skipped: true, code: 'NO_TARGET' }

  const extracted = extractCadastroFieldsFromInbound(userMessage, historyMessages, {
    phoneDigits: telefone,
  })
  if (!extracted.cpf && !extracted.email && !extracted.dataNasc && !extracted.nome) {
    return { ok: true, skipped: true, written: [], code: 'NOTHING_EXTRACTED' }
  }

  const idLead = await resolveCrmLeadId(env, telefone, leadId)
  if (!idLead) return { ok: false, code: 'LEAD_NOT_FOUND' }

  const snapRes = await fetchLeadFormSnapshot(env, idLead)
  const snapshot = snapRes?.ok ? snapRes.snapshot || {} : {}

  const values = []
  const supabase = {}
  const written = []

  if (extracted.nome && snapshotNeedsNome(snapshot)) {
    values.push({ fieldId: EDUIT_FIELD_NOME, name: 'nome', value: extracted.nome })
    supabase.kommo_nome = extracted.nome
    written.push('nome')
  }
  if (extracted.cpf && snapshotNeedsCpf(snapshot)) {
    values.push({ fieldId: EDUIT_FIELD_CPF, name: 'cpf', value: extracted.cpf })
    supabase.kommo_cpf = extracted.cpf
    written.push('cpf')
  }
  if (extracted.email && snapshotNeedsEmail(snapshot)) {
    values.push({ fieldId: EDUIT_FIELD_EMAIL, name: 'email', value: extracted.email })
    supabase.kommo_email = extracted.email
    written.push('email')
  }
  if (extracted.dataNasc && snapshotNeedsDataNasc(snapshot)) {
    const br = formatDataNascBr(extracted.dataNasc)
    values.push({ fieldId: EDUIT_FIELD_DTNASCIMENTO, name: 'dtnascimento', value: br || extracted.dataNasc })
    supabase.kommo_data_nasc = br || extracted.dataNasc
    written.push('dtnascimento')
  }

  if (!values.length) {
    return { ok: true, skipped: true, written: [], code: 'ALREADY_FILLED', extracted }
  }

  if (!isEduitBackend(env) && !isEduitCuid(idLead)) {
    if (telefone && Object.keys(supabase).length) {
      await updateDadosCliente(env, { telefone, fields: supabase }).catch(() => {})
    }
    return { ok: true, skipped: true, written, code: 'EDUIT_ONLY_CARD', extracted }
  }

  const put = await updateDealCustomFields(env, idLead, values)
  if (put.ok && telefone && Object.keys(supabase).length) {
    await updateDadosCliente(env, { telefone, fields: supabase }).catch(() => {})
  }
  return {
    ok: Boolean(put.ok),
    status: put.status,
    error: put.error,
    code: put.ok ? 'WRITTEN' : put.code || 'EDUIT_ERROR',
    written,
    extracted,
    leadId: idLead,
  }
}
