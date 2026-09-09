/**
 * Store para a tabela `dados_cliente` no Supabase principal (banco da IA).
 *
 * Espelha os nodes "Supabase update" que o N8N usa para gravar estado do lead
 * (teste A/B, id_lead no Kommo, atendimento_ia, etc.).
 *
 * Primeiro node implementado aqui:
 *
 *   UPDATE dados_cliente
 *   SET teste_ab = 'IA',
 *       id_lead  = <id retornado do Kommo>
 *   WHERE telefone = <telefoneCorreto>
 *
 * Env necessárias (reutiliza o banco principal):
 *   SUPABASE_URL  (ou VITE_SUPABASE_URL)
 *   SUPABASE_KEY  (ou VITE_SUPABASE_KEY)
 */

/** Tira máscara, @s.whatsapp.net, espaços — deixa só dígitos. */
export function normalizeTelefone(input) {
  if (input == null) return ''
  const raw = String(input).split('@')[0]
  return raw.replace(/[^0-9]/g, '')
}

/** JID WhatsApp usado em várias linhas de `dados_cliente_sum`. */
export function telefoneToWhatsAppJid(digits) {
  const d = normalizeTelefone(digits)
  return d ? `${d}@s.whatsapp.net` : ''
}

/**
 * Filtro PostgREST: telefone no banco pode estar só com dígitos ou com @s.whatsapp.net.
 */
export function dadosClienteTelefoneOrFilter(telefone) {
  const digits = normalizeTelefone(telefone)
  if (!digits) return null
  const local = digits.startsWith('55') && digits.length >= 12 ? digits : digits.length >= 10 && digits.length <= 11 ? `55${digits}` : digits
  const jid = telefoneToWhatsAppJid(local)
  const bare = normalizeTelefone(local)
  const legacyBare = digits !== bare ? digits : null
  const legacyJid = legacyBare ? telefoneToWhatsAppJid(legacyBare) : null
  const parts = [
    `telefone.eq.${encodeURIComponent(bare)}`,
    `telefone.eq.${encodeURIComponent(jid)}`,
  ]
  if (legacyBare) parts.push(`telefone.eq.${encodeURIComponent(legacyBare)}`)
  if (legacyJid && legacyJid !== jid) parts.push(`telefone.eq.${encodeURIComponent(legacyJid)}`)
  return `or=(${parts.join(',')})`
}

export async function fetchDadosClienteByTelefone(env, telefone, select = '*') {
  const filter = dadosClienteTelefoneOrFilter(telefone)
  if (!filter) return null
  const { url, key, table } = getConfig(env)
  if (!url || !key) return null
  try {
    const { ok, data } = await supabaseGet(url, key, `${table}?${filter}&select=${select}&limit=1`)
    if (!ok || !Array.isArray(data) || !data.length) return null
    return data[0]
  } catch {
    return null
  }
}

/** IA pausada após form/handoff — o flush do WhatsApp não deve chamar o orquestrador. */
export async function isAtendimentoIaPaused(env, telefone) {
  const row = await fetchDadosClienteByTelefone(env, telefone, 'atendimento_ia')
  return String(row?.atendimento_ia || '').toLowerCase() === 'pause'
}

/**
 * Lógica pura da decisão do gate de pause — separada para facilitar teste.
 * Veja `shouldHoldOnIaPause` para descrição dos campos.
 */
export function decideHoldOnIaPause(row) {
  const paused = String(row?.atendimento_ia || '').toLowerCase() === 'pause'
  if (!paused) return { hold: false, paused: false, reason: null }
  if (row?.inscricao_form_status === 'desistencia_concluida') {
    return { hold: false, paused: true, reason: 'desistencia_concluida' }
  }
  if (row?.inscricao_form_status === 'aguardando_confirm_desistencia') {
    return { hold: false, paused: true, reason: 'desistencia_confirm' }
  }
  const status = String(row?.inscricao_form_status || '').toLowerCase()
  const captacaoStarted =
    (row?.captacao_candidato_id != null && String(row.captacao_candidato_id).trim() !== '') ||
    (row?.captacao_contrato_link != null && String(row.captacao_contrato_link).trim() !== '') ||
    Boolean(row?.captacao_contrato_link_at) ||
    Boolean(row?.inscricao_form_recebido_at)
  // Só destrava pause espúrio se ainda aguarda formulário E captação não avançou.
  // Se captação/link já existe com status stale, mantém hold (evita loop de reenvio).
  if (status === 'aguardando_form_sumar' && !captacaoStarted) {
    return { hold: false, paused: true, reason: 'spurious_form_pause', clearPause: true }
  }
  // Fila inscrição pós-link: tryHandleMatriculaAceitePagamentoFlow responde reenvio de
  // link, comprovante e dúvidas — o scheduler DEVE drenar o buffer (hold=false).
  if (status === 'aguardando_aceite_contrato') {
    return { hold: false, paused: true, reason: 'matricula_aceite_pagamento' }
  }
  if (status === 'comprovante_pagamento_recebido') {
    return { hold: false, paused: true, reason: 'comprovante_pos_matricula' }
  }
  if (status === 'aguardando_dados_cadastro') {
    return { hold: false, paused: true, reason: 'aguardando_dados_cadastro' }
  }
  if (captacaoStarted) {
    return { hold: true, paused: true, reason: 'aguardando_aceite_ou_captacao' }
  }
  return { hold: true, paused: true, reason: null }
}

/**
 * Decisão composta sobre o gate de IA pausada. Retorna `{ hold, paused, reason }`.
 *
 * - `paused`: cliente está com `atendimento_ia='pause'` no banco.
 * - `hold`: se TRUE, o caller deve abortar o drain (igual ao antigo
 *   `isAtendimentoIaPaused`). Se FALSE mesmo com `paused=true`, existe um
 *   handler "early" (rodado antes do gate do orquestrador) responsável por
 *   responder a mensagem — neste caso o drain DEVE prosseguir.
 * - `reason`: rótulo descritivo do early handler (`'desistencia_concluida'`,
 *   etc.) ou `null` quando `hold=true`.
 *
 * Exceção atual: `inscricao_form_status='desistencia_concluida'` — o lead
 * que voltar a falar precisa receber a mensagem canônica "Sua desistência já
 * foi registrada…" em vez de silêncio.
 */
export async function shouldHoldOnIaPause(env, telefone) {
  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    'atendimento_ia,inscricao_form_status,inscricao_form_recebido_at,captacao_candidato_id,captacao_contrato_link,captacao_contrato_link_at',
  )
  const decision = decideHoldOnIaPause(row)
  if (decision.clearPause) {
    // Limpa o pause AGORA (await) para o gate secundário do agentRunner
    // (isAtendimentoIaPaused) não reler 'pause' defasado e bloquear a resposta.
    await updateDadosCliente(env, { telefone, fields: { atendimento_ia: null } }).catch(() => {})
    console.log(`[ia_pause] pause espúrio limpo (aguardando_form_sumar) telefone=${telefone}`)
  }
  return decision
}

function getConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || ''
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  const table = env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  return { url: url.replace(/\/$/, ''), key, table }
}

async function supabaseGet(url, key, pathAndQuery) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data, raw: text }
}

async function supabasePatch(url, key, pathAndQuery, body) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data, raw: text }
}

/**
 * UPDATE genérico em dados_cliente filtrado por telefone.
 * Retorna a lista de linhas afetadas (Supabase `return=representation`).
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.telefone  telefone normalizado (só dígitos) ou JID
 * @param {Record<string, any>} params.fields  colunas → valores a atualizar
 */
export async function updateDadosCliente(env, { telefone, fields }) {
  const { url, key, table } = getConfig(env)
  if (!url || !key) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED', error: 'Configure SUPABASE_URL e SUPABASE_KEY.' }
  }
  const fone = normalizeTelefone(telefone)
  if (!fone) {
    return { ok: false, code: 'MISSING_TELEFONE', error: 'Informe um telefone válido.' }
  }
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return { ok: false, code: 'MISSING_FIELDS', error: 'Informe ao menos um campo para atualizar.' }
  }

  const telFilter = dadosClienteTelefoneOrFilter(fone)
  if (!telFilter) {
    return { ok: false, code: 'MISSING_TELEFONE', error: 'Informe um telefone válido.' }
  }
  const { ok, status, data, raw } = await supabasePatch(url, key, `${table}?${telFilter}`, fields)
  if (!ok) {
    return {
      ok: false,
      code: 'SUPABASE_UPDATE_FAILED',
      status,
      error: typeof raw === 'string' ? raw.slice(0, 500) : 'erro desconhecido',
    }
  }
  const rows = Array.isArray(data) ? data : []
  return {
    ok: true,
    table,
    telefone: fone,
    updated: rows.length,
    fields,
    rows,
    matched: rows.length > 0,
  }
}

/**
 * Node "Atualizar Cliente" — marca teste A/B = IA + grava id do lead do Kommo.
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.telefone  telefone do lead (JID ou só dígitos)
 * @param {number|string} params.idLead  id retornado pelo Kommo
 */
export async function marcarClienteIA(env, { telefone, idLead }) {
  if (idLead == null || idLead === '') {
    return { ok: false, code: 'MISSING_ID_LEAD', error: 'Informe id_lead (id retornado do CRM).' }
  }
  // text column: preserva CUID EduIT; Kommo numérico continua como número quando possível
  const s = String(idLead).trim()
  const idLeadValue = /^\d+$/.test(s) ? Number(s) : s

  return updateDadosCliente(env, {
    telefone,
    fields: {
      teste_ab: 'IA',
      id_lead: idLeadValue,
    },
  })
}

/**
 * Busca o id_lead gravado em dados_cliente para um telefone.
 * Retorna um número, string ou null. Nunca lança — em qualquer erro devolve null.
 */
/**
 * Garante linha em dados_cliente_sum (PATCH só atualiza linhas existentes).
 */
export async function ensureDadosClienteRow(env, { telefone, idLead, fields = {} }) {
  const { url, key, table } = getConfig(env)
  if (!url || !key) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }
  }
  const fone = normalizeTelefone(telefone)
  if (!fone) return { ok: false, code: 'MISSING_TELEFONE' }

  const existing = await fetchDadosClienteByTelefone(env, telefone, 'id')
  if (existing) {
    if (fields && Object.keys(fields).length > 0) {
      return updateDadosCliente(env, { telefone, fields })
    }
    return { ok: true, created: false, matched: true }
  }

  const jid = telefoneToWhatsAppJid(fone)
  const row = {
    telefone: jid || fone,
    teste_ab: 'IA',
    ...fields,
  }
  if (idLead != null && idLead !== '') {
    const s = String(idLead).trim()
    row.id_lead = /^\d+$/.test(s) ? Number(s) : s
  }

  try {
    const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (!res.ok) {
      return {
        ok: false,
        code: 'SUPABASE_INSERT_FAILED',
        status: res.status,
        error: typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data)?.slice(0, 400),
      }
    }
    return { ok: true, created: true, rows: Array.isArray(data) ? data : [data] }
  } catch (err) {
    return { ok: false, code: 'SUPABASE_INSERT_ERROR', error: err.message }
  }
}

export async function getLeadIdByTelefone(env, telefone) {
  try {
    const { url, key, table } = getConfig(env)
    if (!url || !key) return null
    const row = await fetchDadosClienteByTelefone(env, telefone, 'id_lead,eduit_deal_id')
    if (!row) return null
    // Prefer deal CUID EduIT quando presente — nunca Number() em CUID
    const cuid = row.eduit_deal_id != null && String(row.eduit_deal_id).trim()
      ? String(row.eduit_deal_id).trim()
      : null
    if (cuid && /^c[a-z0-9]{8,}$/i.test(cuid)) return cuid
    const raw = row.id_lead
    if (raw == null || raw === '') return null
    const s = String(raw).trim()
    if (/^c[a-z0-9]{8,}$/i.test(s)) return s
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n : s
  } catch {
    return null
  }
}

/**
 * Busca linha por id_lead ou eduit_deal_id (CUID ou número Kommo como text).
 */
export async function fetchDadosClienteByLeadId(env, leadId, select = 'telefone,id_lead,eduit_deal_id,eduit_contact_id,eduit_conversation_id') {
  const { url, key, table } = getConfig(env)
  if (!url || !key) return null
  const id = String(leadId || '').trim()
  if (!id) return null
  try {
    const filter = `or=(id_lead.eq.${encodeURIComponent(id)},eduit_deal_id.eq.${encodeURIComponent(id)})`
    const { ok, data } = await supabaseGet(url, key, `${table}?${filter}&select=${select}&limit=1`)
    if (!ok || !Array.isArray(data) || !data.length) return null
    return data[0]
  } catch {
    return null
  }
}
