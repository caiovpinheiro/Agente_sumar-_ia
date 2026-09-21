/**
 * Cliente mínimo da API EduIT CRM — contratos homologados (Sprint A).
 *
 * Env:
 *   EDUIT_BASE_URL   ex: https://integrations.bwipo.com
 *   EDUIT_API_KEY    Bearer (nunca hardcode / nunca logar)
 *
 * Stages (defaults homologados; override via EDUIT_STAGE_*):
 *   Lead de Entrada, Atendimento, Inscrição, …
 *
 * Nunca use número do deal para ler/escrever custom fields — sempre CUID.
 */

/** @type {const} */
export const EDUIT_DEFAULT_STAGES = {
  pipelineId: 'cmt38aydx01q3rw01kkpjklmk',
  entrada: 'cmt3egueb098fl2015ar3320t',
  atendimento: 'cmt38aydx01q5rw01422frucd',
  aguardandoResposta: 'cmt38aydx01q6rw017rg3a84t',
  inscricao: 'cmt38aydx01q7rw01w0of9px5',
  aguardandoPagamento: 'cmt38aydx01q8rw010d91vy1t',
  fechamento: 'cmt38aydx01q9rw017pcp64ic',
  ganho: 'cmt38aydx01qarw01q4he9y9a',
  perdido: 'cmt38aydx01qbrw01sd97lahm',
}

/** Automação EduIT que envia o formulário (legado; o disparo atual é pela tag). */
export const EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID = 'cmtbpgc9909ato701am40ffww'

/** Tag EduIT "Formulario" — adicionar no deal dispara o WhatsApp Flow. */
export const EDUIT_DEFAULT_FORMULARIO_TAG_ID = 'cmth9k8ne129wqm01rd7d464s'

/** Tag EduIT "Problema_Mat" — hold temporário da matrícula (automação CRM). */
export const EDUIT_DEFAULT_PROBLEMA_MAT_TAG_ID = 'cmubbeyk23753ld013ayyr9lm'

/** Automação EduIT disparada pela tag Problema_Mat (não usar POST /run). */
export const EDUIT_DEFAULT_PROBLEMA_MAT_AUTOMATION_ID = 'cmubbe71p36zbld01z049vy8x'

export function isMatriculaProblemaHoldEnabled(env = process.env) {
  const v = String(env?.MATRICULA_PROBLEMA_HOLD ?? 'true').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no'
}

export function resolveEduitProblemaMatTagId(env = process.env) {
  const fromEnv = String(env?.EDUIT_TAG_PROBLEMA_MAT_ID || '').trim()
  if (fromEnv && isEduitCuid(fromEnv)) return fromEnv
  return EDUIT_DEFAULT_PROBLEMA_MAT_TAG_ID
}

export function resolveEduitProblemaMatAutomationId(env = process.env) {
  const fromEnv = String(env?.EDUIT_AUTOMATION_PROBLEMA_MAT_ID || '').trim()
  if (fromEnv && isEduitCuid(fromEnv)) return fromEnv
  return EDUIT_DEFAULT_PROBLEMA_MAT_AUTOMATION_ID
}

export function resolveEduitFormularioAutomationId(env = process.env) {
  const fromEnv = String(env?.EDUIT_AUTOMATION_FORMULARIO_SUM_ID || '').trim()
  if (fromEnv && isEduitCuid(fromEnv)) return fromEnv
  return EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID
}

export function resolveEduitFormularioTagId(env = process.env) {
  const fromEnv = String(env?.EDUIT_TAG_FORMULARIO_ID || '').trim()
  if (fromEnv && isEduitCuid(fromEnv)) return fromEnv
  return EDUIT_DEFAULT_FORMULARIO_TAG_ID
}

export function getEduitConfig(env = process.env) {
  return {
    base: String(env.EDUIT_BASE_URL || '').replace(/\/$/, ''),
    token: String(env.EDUIT_API_KEY || '').trim(),
  }
}

export function resolveEduitStages(env = process.env) {
  return {
    pipelineId: String(env.EDUIT_PIPELINE_ID || EDUIT_DEFAULT_STAGES.pipelineId).trim(),
    entrada: String(env.EDUIT_STAGE_ENTRADA || EDUIT_DEFAULT_STAGES.entrada).trim(),
    atendimento: String(env.EDUIT_STAGE_ATENDIMENTO || EDUIT_DEFAULT_STAGES.atendimento).trim(),
    aguardandoResposta: String(env.EDUIT_STAGE_AGUARDANDO_RESPOSTA || EDUIT_DEFAULT_STAGES.aguardandoResposta).trim(),
    inscricao: String(env.EDUIT_STAGE_INSCRICAO || EDUIT_DEFAULT_STAGES.inscricao).trim(),
    aguardandoPagamento: String(env.EDUIT_STAGE_AGUARDANDO_PAGAMENTO || EDUIT_DEFAULT_STAGES.aguardandoPagamento).trim(),
    fechamento: String(env.EDUIT_STAGE_FECHAMENTO || EDUIT_DEFAULT_STAGES.fechamento).trim(),
    ganho: String(env.EDUIT_STAGE_GANHO || EDUIT_DEFAULT_STAGES.ganho).trim(),
    perdido: String(env.EDUIT_STAGE_PERDIDO || EDUIT_DEFAULT_STAGES.perdido).trim(),
  }
}

/** Stages em que a IA atende (inclui Aguardando pagamento para comprovante/reenvio). */
export function eduitAgentStageIds(env = process.env) {
  const s = resolveEduitStages(env)
  return [s.atendimento, s.inscricao, s.aguardandoPagamento].filter(Boolean)
}

export function isEduitCuid(value) {
  const s = String(value || '').trim()
  if (!s) return false
  // CUIDs EduIT observados: cmt… / c… — nunca coerção numérica
  return /^c[a-z0-9]{8,}$/i.test(s)
}

function digitsOnly(input) {
  return String(input || '').replace(/[^0-9]/g, '')
}

function summarizeError(r) {
  if (r?.error) return r.error
  if (typeof r?.raw === 'string') {
    const raw = r.raw.trim()
    if (raw.startsWith('<') && /<html/i.test(raw)) {
      return `HTTP ${r.status || '?'} HTML (proxy/WAF?), não JSON EduIT. URL: ${r.requestUrl || 'n/a'}`
    }
    return raw.slice(0, 400)
  }
  return `status ${r?.status ?? '?'}`
}

/**
 * @returns {Promise<{ ok:boolean, status?:number, data?:any, raw?:string, code?:string, error?:string, requestUrl?:string }>}
 */
export async function eduitFetch(env, path, { method = 'GET', body } = {}) {
  const { base, token } = getEduitConfig(env)
  if (!base || !token) {
    return {
      ok: false,
      code: 'EDUIT_NOT_CONFIGURED',
      error: 'Configure EDUIT_BASE_URL e EDUIT_API_KEY.',
    }
  }
  const requestUrl = `${base}${path.startsWith('/') ? path : `/${path}`}`
  try {
    const res = await fetch(requestUrl, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }
    return { ok: res.ok, status: res.status, data, raw, requestUrl }
  } catch (e) {
    return { ok: false, code: 'EDUIT_FETCH_FAILED', error: e.message, requestUrl }
  }
}

function asItemList(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.messages)) return data.messages
  if (Array.isArray(data.data)) return data.data
  if (Array.isArray(data.contacts)) return data.contacts
  if (Array.isArray(data.deals)) return data.deals
  if (Array.isArray(data.conversations)) return data.conversations
  if (data.id) return [data]
  return []
}

/** Tipos de mensagem EduIT excluídos do histórico do agente. */
const EDUIT_HISTORY_SKIP_TYPES = new Set([
  'note',
  'system',
  'activity',
  'event',
  'call',
  'tag_event',
  'template_event',
])

/**
 * Timestamp utilizável em ms (número). Aceita ISO / Date / epoch s|ms.
 * @param {any} raw
 * @returns {number|null}
 */
export function parseEduitMessageAt(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // epoch segundos (< 1e12) → ms
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
  }
  if (raw instanceof Date) {
    const t = raw.getTime()
    return Number.isFinite(t) ? t : null
  }
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * Direção / role → user | assistant | null.
 * @param {any} m
 * @returns {'user'|'assistant'|null}
 */
export function resolveEduitMessageRole(m) {
  if (!m || typeof m !== 'object') return null
  const dir = String(m.direction || m.dir || '').trim().toLowerCase()
  if (dir === 'in' || dir === 'inbound') return 'user'
  if (dir === 'out' || dir === 'outbound') return 'assistant'
  const role = String(m.role || m.authorRole || m.senderRole || '').trim().toLowerCase()
  if (role === 'user' || role === 'lead' || role === 'contact' || role === 'customer') return 'user'
  if (role === 'assistant' || role === 'agent' || role === 'bot' || role === 'operator' || role === 'human') {
    return 'assistant'
  }
  return null
}

function eduitMessageContent(m) {
  if (!m || typeof m !== 'object') return ''
  const c = m.content ?? m.text ?? m.body ?? m.message
  if (typeof c === 'string') return c
  if (c && typeof c === 'object' && typeof c.text === 'string') return c.text
  return ''
}

/**
 * Normaliza item cru da API → shape do agente, ou null se filtrado.
 * `at` é sempre epoch ms (número) quando disponível.
 * @param {any} raw
 * @param {number} index
 * @returns {{id:string|null,role:string,content:string,at:number|null,seq:number|null,source:'eduit'}|null}
 */
export function normalizeEduitConversationMessage(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.isPrivate === true || raw.private === true || raw.is_private === true) return null
  const type = String(raw.messageType || raw.type || raw.kind || '').trim().toLowerCase()
  if (type && EDUIT_HISTORY_SKIP_TYPES.has(type)) return null
  const role = resolveEduitMessageRole(raw)
  const content = String(eduitMessageContent(raw) || '').trim()
  if (!role || !content) return null

  const idRaw = raw.id ?? raw.messageId ?? raw.message_id
  const id = idRaw != null && String(idRaw).trim() ? String(idRaw).trim() : null
  const at = parseEduitMessageAt(
    raw.at ?? raw.timestamp ?? raw.createdAt ?? raw.created_at ?? raw.sentAt ?? raw.sent_at ?? raw.date,
  )
  let seq = null
  if (raw.seq != null && Number.isFinite(Number(raw.seq))) seq = Number(raw.seq)
  else if (raw.sequence != null && Number.isFinite(Number(raw.sequence))) seq = Number(raw.sequence)
  else if (raw.order != null && Number.isFinite(Number(raw.order))) seq = Number(raw.order)
  else seq = index

  return { id, role, content, at, seq, source: 'eduit' }
}

/**
 * Normaliza id da mensagem criada: `{id}`, `{messageId}` ou `{message:{id}}`.
 * @param {any} data
 * @returns {string|null}
 */
export function extractMessageId(data) {
  if (data == null) return null
  if (typeof data === 'string') {
    const s = data.trim()
    return s || null
  }
  if (typeof data !== 'object') return null
  const direct = data.id ?? data.messageId ?? data.message_id
  if (direct != null && String(direct).trim()) return String(direct).trim()
  const nested = data.message
  if (nested && typeof nested === 'object') {
    const nid = nested.id ?? nested.messageId ?? nested.message_id
    if (nid != null && String(nid).trim()) return String(nid).trim()
  }
  return null
}

/** Coleta dígitos de telefone de um contato EduIT (campos comuns). */
export function contactPhoneDigits(contact) {
  if (!contact || typeof contact !== 'object') return []
  const out = []
  const push = (v) => {
    const d = digitsOnly(v)
    if (d) out.push(d)
  }
  push(contact.phone)
  push(contact.whatsapp)
  push(contact.mobile)
  push(contact.celular)
  push(contact.telefone)
  if (Array.isArray(contact.phones)) {
    for (const p of contact.phones) {
      if (typeof p === 'string') push(p)
      else if (p && typeof p === 'object') push(p.number || p.value || p.phone || p.e164)
    }
  }
  return [...new Set(out)]
}

/**
 * Prefere contato cujo telefone normalizado bata exatamente com o query.
 * Fallback: primeiro da lista (determinístico pela ordem da API).
 * @returns {{ contact: object|null, reason: string }}
 */
export function pickPreferredContact(contacts, telefone) {
  const list = Array.isArray(contacts) ? contacts.filter(Boolean) : []
  if (!list.length) return { contact: null, reason: 'no_contacts' }
  const want = digitsOnly(telefone)
  if (!want) return { contact: list[0], reason: 'first_no_query' }

  const variants = new Set([want])
  // BR: com/sem 55
  if (want.startsWith('55') && want.length >= 12) variants.add(want.slice(2))
  else if (want.length >= 10 && want.length <= 11) variants.add(`55${want}`)

  for (const c of list) {
    const phones = contactPhoneDigits(c)
    if (phones.some((p) => variants.has(p))) {
      return { contact: c, reason: 'exact_phone' }
    }
  }
  return { contact: list[0], reason: 'first_fallback' }
}

function conversationTimestamp(c) {
  return (
    Date.parse(c?.updatedAt || c?.updated_at || c?.lastMessageAt || c?.last_message_at || c?.createdAt || c?.created_at || 0) ||
    0
  )
}

function isConversationClosed(c) {
  if (!c || typeof c !== 'object') return false
  if (c.isClosed === true || c.closed === true) return true
  if (c.isOpen === false || c.open === false) return true
  const st = String(c.status || c.state || '').trim().toLowerCase()
  if (!st) return false
  return ['closed', 'archived', 'inactive', 'ended', 'resolved'].includes(st)
}

function isConversationOpenish(c) {
  if (!c || typeof c !== 'object') return false
  if (isConversationClosed(c)) return false
  if (c.isOpen === true || c.open === true || c.isClosed === false) return true
  const st = String(c.status || c.state || '').trim().toLowerCase()
  if (!st) return false
  return ['open', 'active', 'opened', 'in_progress', 'ongoing'].includes(st)
}

/**
 * Prefere conversa aberta/ativa e mais recente; fallback determinístico (mais recente / 1º).
 * @returns {{ conversation: object|null, reason: string }}
 */
export function pickPreferredConversation(conversations) {
  const list = Array.isArray(conversations) ? conversations.filter(Boolean) : []
  if (!list.length) return { conversation: null, reason: 'no_conversations' }

  const hasOpenHints = list.some(
    (c) =>
      c.isClosed != null ||
      c.closed != null ||
      c.isOpen != null ||
      c.open != null ||
      (c.status != null && String(c.status).trim() !== '') ||
      (c.state != null && String(c.state).trim() !== ''),
  )

  let pool = list
  let reasonPrefix = 'most_recent'
  if (hasOpenHints) {
    const open = list.filter((c) => isConversationOpenish(c))
    if (open.length) {
      pool = open
      reasonPrefix = 'open_most_recent'
    } else {
      const notClosed = list.filter((c) => !isConversationClosed(c))
      if (notClosed.length) {
        pool = notClosed
        reasonPrefix = 'not_closed_most_recent'
      }
    }
  }

  const sorted = [...pool].sort((a, b) => {
    const tb = conversationTimestamp(b)
    const ta = conversationTimestamp(a)
    if (tb !== ta) return tb - ta
    // desempate estável por id
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
  const conversation = sorted[0]
  return { conversation, reason: `${reasonPrefix}:${conversation?.id || '?'}` }
}

/**
 * GET /api/contacts?phone=<digits>
 * @returns {{ ok, contact?, contacts, matched, status?, error? }}
 */
export async function findContactsByPhone(env, telefone) {
  const digits = digitsOnly(telefone)
  if (!digits) {
    return { ok: false, code: 'MISSING_TELEFONE', error: 'telefone vazio', contacts: [], matched: 0 }
  }
  const r = await eduitFetch(env, `/api/contacts?phone=${encodeURIComponent(digits)}`)
  if (!r.ok) {
    return {
      ok: false,
      code: r.code || 'EDUIT_ERROR',
      status: r.status,
      error: summarizeError(r),
      contacts: [],
      matched: 0,
    }
  }
  const contacts = asItemList(r.data)
  const { contact, reason } = pickPreferredContact(contacts, digits)
  return {
    ok: true,
    contact: contact || null,
    contacts,
    matched: contacts.length,
    pickReason: reason,
    status: r.status,
  }
}

/**
 * GET /api/deals?contactId=<cuid>
 * Shape listagem: { items, total, page, perPage }
 */
export async function listDealsByContactId(env, contactId, { perPage = 50, page = 1 } = {}) {
  const id = String(contactId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_CONTACT_ID', error: 'contactId CUID inválido', deals: [] }
  }
  const qs = new URLSearchParams({
    contactId: id,
    perPage: String(Math.min(200, Math.max(1, Number(perPage) || 50))),
    page: String(Math.max(1, Number(page) || 1)),
  })
  const r = await eduitFetch(env, `/api/deals?${qs}`)
  if (!r.ok) {
    return {
      ok: false,
      code: r.code || 'EDUIT_ERROR',
      status: r.status,
      error: summarizeError(r),
      deals: [],
    }
  }
  const deals = asItemList(r.data)
  return {
    ok: true,
    deals,
    total: r.data?.total ?? deals.length,
    page: r.data?.page ?? page,
    perPage: r.data?.perPage ?? perPage,
    status: r.status,
  }
}

/**
 * GET /api/deals?stageId=<cuid>&perPage=...
 */
export async function listDealsByStageId(env, stageId, { perPage = 100, page = 1, maxPages = 5 } = {}) {
  const sid = String(stageId || '').trim()
  if (!sid || !isEduitCuid(sid)) {
    return { ok: false, code: 'MISSING_STAGE_ID', error: 'stageId CUID inválido', deals: [] }
  }
  const all = []
  let cur = Math.max(1, Number(page) || 1)
  const limit = Math.min(200, Math.max(1, Number(perPage) || 100))
  let lastStatus = null
  let total = null
  while (cur <= maxPages) {
    const qs = new URLSearchParams({
      stageId: sid,
      perPage: String(limit),
      page: String(cur),
    })
    const r = await eduitFetch(env, `/api/deals?${qs}`)
    lastStatus = r.status
    if (!r.ok) {
      return {
        ok: all.length > 0,
        code: r.code || 'EDUIT_ERROR',
        status: r.status,
        error: summarizeError(r),
        deals: all,
      }
    }
    const batch = asItemList(r.data)
    total = r.data?.total ?? total
    all.push(...batch)
    if (batch.length < limit) break
    if (total != null && all.length >= total) break
    cur += 1
  }
  return { ok: true, deals: all, total: total ?? all.length, status: lastStatus }
}

/**
 * GET /api/deals/{cuid} — nunca use número para custom fields.
 */
export async function getDealById(env, dealId) {
  const id = String(dealId || '').trim()
  if (!id) {
    return { ok: false, code: 'MISSING_DEAL_ID', error: 'dealId ausente' }
  }
  if (/^\d+$/.test(id)) {
    return {
      ok: false,
      code: 'DEAL_NUMBER_FORBIDDEN',
      error: 'Use o CUID do deal — número não carrega custom fields.',
    }
  }
  if (!isEduitCuid(id)) {
    return { ok: false, code: 'INVALID_DEAL_ID', error: 'dealId deve ser CUID EduIT' }
  }
  const r = await eduitFetch(env, `/api/deals/${encodeURIComponent(id)}`)
  if (!r.ok) {
    return { ok: false, code: r.code || 'EDUIT_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, deal: r.data, status: r.status }
}

/** PUT /api/deals/{cuid} { stageId } */
export async function updateDealStage(env, dealId, stageId) {
  const id = String(dealId || '').trim()
  const sid = String(stageId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_DEAL_ID', error: 'dealId CUID inválido' }
  }
  if (!sid || !isEduitCuid(sid)) {
    return { ok: false, code: 'MISSING_STAGE_ID', error: 'stageId CUID inválido' }
  }
  const r = await eduitFetch(env, `/api/deals/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { stageId: sid },
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'EDUIT_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, status: r.status, data: r.data }
}

/**
 * PUT /api/deals/{cuid}/custom-fields
 * Body EXATO: { values: [{ fieldId, name, value }] }
 */
export async function updateDealCustomFields(env, dealId, values) {
  const id = String(dealId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_DEAL_ID', error: 'dealId CUID inválido' }
  }
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, code: 'MISSING_VALUES', error: 'values[] obrigatório' }
  }
  const r = await eduitFetch(env, `/api/deals/${encodeURIComponent(id)}/custom-fields`, {
    method: 'PUT',
    body: { values },
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'EDUIT_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, status: r.status, data: r.data }
}

/** POST /api/deals/{cuid}/notes { content } */
export async function createDealNote(env, dealId, content) {
  const id = String(dealId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_DEAL_ID', error: 'dealId CUID inválido' }
  }
  const text = String(content ?? '')
  const r = await eduitFetch(env, `/api/deals/${encodeURIComponent(id)}/notes`, {
    method: 'POST',
    body: { content: text },
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'EDUIT_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, status: r.status, data: r.data, noteId: r.data?.id || null }
}

/**
 * POST /api/deals/{cuid}/tags { tagId }
 * Acrescenta a tag sem remover as existentes.
 */
export async function addDealTag(env, dealId, tagId) {
  const id = String(dealId || '').trim()
  const tag = String(tagId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_DEAL_ID', error: 'dealId CUID inválido' }
  }
  if (!tag || !isEduitCuid(tag)) {
    return { ok: false, code: 'MISSING_TAG_ID', error: 'tagId CUID inválido' }
  }
  const r = await eduitFetch(env, `/api/deals/${encodeURIComponent(id)}/tags`, {
    method: 'POST',
    body: { tagId: tag },
  })
  if (!r.ok) {
    return {
      ok: false,
      code: r.code || 'EDUIT_ERROR',
      status: r.status,
      error: summarizeError(r),
      data: r.data,
      dealId: id,
      tagId: tag,
    }
  }
  return {
    ok: true,
    status: r.status,
    data: r.data,
    dealId: id,
    tagId: tag,
  }
}

/**
 * POST /api/automations/{cuid}/run { dealId }
 * Dispara uma automação no negócio (substituto EduIT do salesbot Formulario_Sum).
 */
export async function runEduitAutomation(env, automationId, { dealId } = {}) {
  const autoId = String(automationId || '').trim()
  const id = String(dealId || '').trim()
  if (!autoId || !isEduitCuid(autoId)) {
    return { ok: false, code: 'MISSING_AUTOMATION_ID', error: 'automationId CUID inválido' }
  }
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_DEAL_ID', error: 'dealId CUID inválido' }
  }
  const r = await eduitFetch(env, `/api/automations/${encodeURIComponent(autoId)}/run`, {
    method: 'POST',
    body: { dealId: id },
  })
  if (!r.ok) {
    const code =
      r.status === 401 || r.status === 403
        ? 'EDUIT_AUTOMATION_FORBIDDEN'
        : r.code || 'EDUIT_ERROR'
    return {
      ok: false,
      code,
      status: r.status,
      error: summarizeError(r),
      data: r.data,
      automationId: autoId,
      dealId: id,
    }
  }
  return {
    ok: true,
    status: r.status,
    data: r.data,
    runId: r.data?.id || r.data?.runId || null,
    automationId: autoId,
    dealId: id,
  }
}

/** GET /api/conversations?contactId=<cuid> */
export async function listConversationsByContactId(env, contactId) {
  const id = String(contactId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_CONTACT_ID', error: 'contactId CUID inválido', conversations: [] }
  }
  const r = await eduitFetch(env, `/api/conversations?contactId=${encodeURIComponent(id)}`)
  if (!r.ok) {
    return {
      ok: false,
      code: r.code || 'EDUIT_ERROR',
      status: r.status,
      error: summarizeError(r),
      conversations: [],
    }
  }
  const conversations = asItemList(r.data)
  const { conversation, reason } = pickPreferredConversation(conversations)
  return {
    ok: true,
    conversations,
    conversation: conversation || null,
    pickReason: reason,
    status: r.status,
  }
}

/**
 * GET /api/conversations/{cuid}/messages?limit=N
 * Normaliza para histórico do agente (user/assistant), filtra ruído interno.
 * `at` = epoch ms (número) quando parseável.
 *
 * @returns {Promise<{ ok:boolean, messages:Array, status?:number, error?:string, code?:string }>}
 */
export async function listConversationMessages(env, conversationId, { limit = 30 } = {}) {
  const id = String(conversationId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return {
      ok: false,
      code: 'MISSING_CONVERSATION_ID',
      error: 'conversationId CUID inválido',
      messages: [],
    }
  }
  const lim = Math.min(100, Math.max(1, Number(limit) || 30))
  const r = await eduitFetch(
    env,
    `/api/conversations/${encodeURIComponent(id)}/messages?limit=${encodeURIComponent(String(lim))}`,
  )
  if (!r.ok) {
    return {
      ok: false,
      code: r.code || 'EDUIT_ERROR',
      status: r.status,
      error: summarizeError(r),
      messages: [],
    }
  }
  const rawList = asItemList(r.data)
  const normalized = []
  for (let i = 0; i < rawList.length; i++) {
    const m = normalizeEduitConversationMessage(rawList[i], i)
    if (m) normalized.push(m)
  }
  normalized.sort((a, b) => {
    const ta = a.at == null ? Number.POSITIVE_INFINITY : a.at
    const tb = b.at == null ? Number.POSITIVE_INFINITY : b.at
    if (ta !== tb) return ta - tb
    const sa = a.seq == null ? 0 : a.seq
    const sb = b.seq == null ? 0 : b.seq
    if (sa !== sb) return sa - sb
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
  return { ok: true, messages: normalized, status: r.status }
}

/** POST /api/conversations/{conversationCuid}/messages { type:'text', content } */
export async function sendConversationText(env, conversationId, content) {
  const id = String(conversationId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_CONVERSATION_ID', error: 'conversationId CUID inválido' }
  }
  const text = String(content ?? '')
  if (!text.trim()) {
    return { ok: false, code: 'EMPTY_BODY', error: 'texto vazio' }
  }
  const r = await eduitFetch(env, `/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: { type: 'text', content: text },
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'EDUIT_ERROR', status: r.status, error: summarizeError(r), data: r.data }
  }
  return {
    ok: true,
    status: r.status,
    data: r.data,
    messageId: extractMessageId(r.data),
  }
}

/**
 * Grava nota na conversa sem enviar WhatsApp.
 * POST { messageType:'note', content } — homologado: 201, isPrivate, id CUID (não wamid).
 * Qualquer type text/interactive dispara o canal de verdade.
 */
export async function logConversationNote(env, conversationId, content) {
  const id = String(conversationId || '').trim()
  if (!id || !isEduitCuid(id)) {
    return { ok: false, code: 'MISSING_CONVERSATION_ID', error: 'conversationId CUID inválido' }
  }
  const text = String(content ?? '').trim()
  if (!text) {
    return { ok: false, code: 'EMPTY_BODY', error: 'nota vazia' }
  }
  const r = await eduitFetch(env, `/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: { messageType: 'note', content: text },
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'EDUIT_ERROR', status: r.status, error: summarizeError(r), data: r.data }
  }
  return {
    ok: true,
    status: r.status,
    data: r.data,
    messageId: extractMessageId(r.data),
  }
}

/**
 * Preferência de deal: Atendimento/Inscrição; senão o mais recente.
 * @returns {{ deal: object|null, reason: string }}
 */
export function pickPreferredDeal(deals, env = process.env) {
  const list = Array.isArray(deals) ? deals.filter(Boolean) : []
  if (!list.length) return { deal: null, reason: 'no_deals' }
  const stages = resolveEduitStages(env)
  const preferredIds = new Set([stages.atendimento, stages.inscricao])
  const preferred = list.filter((d) => preferredIds.has(String(d.stageId || d.stage_id || '')))
  const pool = preferred.length ? preferred : list
  const sorted = [...pool].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.updated_at || a.createdAt || a.created_at || 0) || 0
    const tb = Date.parse(b.updatedAt || b.updated_at || b.createdAt || b.created_at || 0) || 0
    if (tb !== ta) return tb - ta
    const na = Number(a.number) || 0
    const nb = Number(b.number) || 0
    return nb - na
  })
  const deal = sorted[0]
  const reason = preferred.length
    ? `preferred_stage:${deal.stageId || deal.stage_id}`
    : `most_recent:${deal.id}`
  return { deal, reason }
}

/**
 * Resolve telefone → contact + deal + conversation (sem criar entidades).
 */
export async function resolveEduitEntitiesByPhone(env, telefone) {
  const contactLookup = await findContactsByPhone(env, telefone)
  if (!contactLookup.ok) {
    return { ok: false, ...contactLookup, contactId: null, dealId: null, conversationId: null }
  }
  if (!contactLookup.contact?.id) {
    return {
      ok: true,
      matched: 0,
      contactId: null,
      dealId: null,
      conversationId: null,
      reason: 'contact_not_found',
    }
  }
  const contactId = String(contactLookup.contact.id)
  const dealsRes = await listDealsByContactId(env, contactId)
  if (!dealsRes.ok) {
    return {
      ok: false,
      error: dealsRes.error,
      code: dealsRes.code,
      contactId,
      dealId: null,
      conversationId: null,
    }
  }
  const { deal, reason: dealPickReason } = pickPreferredDeal(dealsRes.deals, env)
  const dealId = deal?.id ? String(deal.id) : null
  let conversationId = null
  const convRes = await listConversationsByContactId(env, contactId)
  if (convRes.ok && convRes.conversation?.id) {
    conversationId = String(convRes.conversation.id)
  }
  return {
    ok: true,
    contactId,
    dealId,
    conversationId,
    contact: contactLookup.contact,
    deal: deal || null,
    dealsMatched: dealsRes.deals.length,
    dealPickReason: dealId ? dealPickReason : 'no_deal',
    conversation: convRes.conversation || null,
  }
}
