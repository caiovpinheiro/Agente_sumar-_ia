/**
 * Resgata leads presos em distribuir_consultor por MISSING_FIELDS (cadastro).
 * Extrai e-mail/CPF/data_nasc do histórico, grava no card e destrava a IA.
 *
 * Uso:
 *   node scripts/rescue-cadastro-preso.mjs
 *   node scripts/rescue-cadastro-preso.mjs --limit 50
 *   node scripts/rescue-cadastro-preso.mjs --telefone 5511999999999
 *   node scripts/rescue-cadastro-preso.mjs --apply
 *   node scripts/rescue-cadastro-preso.mjs --apply --retry-captacao
 *
 * Dry-run é o default (sem escrita). --apply grava card + destrava Supabase.
 * --retry-captacao (opt-in) chama tryAdvanceInscricaoPostFormScheduler após destravar.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeTelefone,
  updateDadosCliente,
  fetchDadosClienteByTelefone,
} from '../server/dadosClienteStore.js'
import { resolveCrmLeadId, loadCrmRecentMessages } from '../server/crmAdapter.js'
import { fetchLeadFormSnapshot } from '../server/inscricaoKommoFields.js'
import { readChatMessages } from '../server/historyStore.js'
import {
  persistCadastroFieldsFromInbound,
  snapshotNeedsEmail,
  snapshotNeedsCpf,
  snapshotNeedsDataNasc,
} from '../server/cadastroCardSync.js'
import { extractCadastroFieldsFromInbound, formatDataNascBr } from '../libShared/cadastroInboundExtract.js'
import { tryAdvanceInscricaoPostFormScheduler } from '../server/inscricaoPostFormPipeline.js'
import {
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DADOS_CADASTRO,
} from '../libShared/inscricaoFormHeuristics.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HISTORY_LIMIT = 40
const PAGE_SIZE = 200
const DEFAULT_LIMIT = 200
const INTER_LEAD_MS_DRY = 80
const INTER_LEAD_MS_APPLY = 1500

const env = { ...process.env }
for (const file of ['.env', '.env.recovery']) {
  const p = path.join(ROOT, file)
  if (!fs.existsSync(p)) continue
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    if (!env[k]) env[k] = line.slice(i + 1)
  }
}

// A mensagem retida pelo gate de pause nunca chegou ao chat_messages (o
// saveConversation roda depois do agente), então o dado só existe na conversa
// EduIT — e pode ser bem mais antigo que a janela padrão de 72h.
if (!env.AGENT_EDUIT_HISTORY_MAX_AGE_HOURS) env.AGENT_EDUIT_HISTORY_MAX_AGE_HOURS = '2160'

function parseArgs(argv) {
  const out = {
    apply: false,
    retryCaptacao: false,
    incluirCardCompleto: false,
    limit: DEFAULT_LIMIT,
    telefone: '',
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--apply') out.apply = true
    else if (a === '--retry-captacao') out.retryCaptacao = true
    else if (a === '--incluir-card-completo') out.incluirCardCompleto = true
    else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length))
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n)
    } else if (a === '--limit') {
      const n = Number(argv[i + 1])
      if (Number.isFinite(n) && n > 0) {
        out.limit = Math.floor(n)
        i += 1
      }
    } else if (a.startsWith('--telefone=')) {
      out.telefone = normalizeTelefone(a.slice('--telefone='.length))
    } else if (a === '--telefone') {
      out.telefone = normalizeTelefone(argv[i + 1] || '')
      i += 1
    }
  }
  return out
}

function printHelp() {
  console.log(`rescue-cadastro-preso — resgata leads em distribuir_consultor com cadastro incompleto

Dry-run (padrão, sem escrita):
  node scripts/rescue-cadastro-preso.mjs
  node scripts/rescue-cadastro-preso.mjs --limit 50
  node scripts/rescue-cadastro-preso.mjs --telefone 5511999999999

Apply (grava card + destrava IA → aguardando_dados_cadastro):
  node scripts/rescue-cadastro-preso.mjs --apply
  node scripts/rescue-cadastro-preso.mjs --apply --retry-captacao
  node scripts/rescue-cadastro-preso.mjs --apply --telefone 5511999999999

Flags:
  --apply              escreve card EduIT + updateDadosCliente
  --retry-captacao     após destravar, chama tryAdvanceInscricaoPostFormScheduler
  --incluir-card-completo  limpa atendimento_ia de quem já tem card completo
                           (mantém distribuir_consultor — status terminal de propósito)
  --limit N            máx. leads (default ${DEFAULT_LIMIT})
  --telefone <num>     processa um único lead
`)
}

function todayStamp() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

function getSupabase(e) {
  const url = String(e.SUPABASE_URL || e.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = String(e.SUPABASE_KEY || e.VITE_SUPABASE_KEY || '')
  const table = e.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum'
  return { url, key, table }
}

async function supabaseGet(url, key, pathAndQuery) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { ok: res.ok, status: res.status, data, raw: text }
}

function maskEmail(email) {
  const s = String(email || '').trim()
  const at = s.indexOf('@')
  if (at <= 0) return s ? '***' : ''
  const local = s.slice(0, at)
  const domain = s.slice(at)
  const keep = Math.min(2, local.length)
  return `${local.slice(0, keep)}***${domain}`
}

function maskCpf(cpf) {
  const d = String(cpf || '').replace(/\D/g, '')
  if (!d) return ''
  return d.length >= 3 ? `***${d.slice(-3)}` : '***'
}

function maskExtraido(extraido) {
  return {
    email: extraido?.email ? maskEmail(extraido.email) : '',
    cpf: extraido?.cpf ? maskCpf(extraido.cpf) : '',
    dataNasc: extraido?.dataNasc || '',
    nome: extraido?.nome ? String(extraido.nome).slice(0, 12) : '',
  }
}

function fieldsMissing(snapshot) {
  const faltando = []
  if (snapshotNeedsEmail(snapshot)) faltando.push('email')
  if (snapshotNeedsCpf(snapshot)) faltando.push('cpf')
  if (snapshotNeedsDataNasc(snapshot)) faltando.push('data_nasc')
  return faltando
}

/** Campos que seriam gravados no dry-run (mesma lógica de persistCadastroFieldsFromInbound). */
function planWrites(extracted, snapshot) {
  const written = []
  const values = {}
  if (extracted.email && snapshotNeedsEmail(snapshot)) {
    written.push('email')
    values.email = extracted.email
  }
  if (extracted.cpf && snapshotNeedsCpf(snapshot)) {
    written.push('cpf')
    values.cpf = extracted.cpf
  }
  if (extracted.dataNasc && snapshotNeedsDataNasc(snapshot)) {
    written.push('dtnascimento')
    values.dataNasc = formatDataNascBr(extracted.dataNasc) || extracted.dataNasc
  }
  return { written, values }
}

async function listDistribuirConsultorRows({ url, key, table, limit, telefone }) {
  if (telefone) {
    const row = await fetchDadosClienteByTelefone(
      env,
      telefone,
      'telefone,id_lead,eduit_deal_id,atendimento_ia,inscricao_form_status',
    )
    if (!row) return []
    // Em lote só varremos distribuir_consultor; no modo --telefone aceitamos
    // também quem já foi resgatado, para permitir a retomada da captação.
    const alvos = [
      INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DADOS_CADASTRO,
    ]
    if (!alvos.includes(String(row.inscricao_form_status || '').trim())) {
      console.warn(
        `[skip] telefone=${telefone} status=${row.inscricao_form_status || '(vazio)'} (esperado ${alvos.join(' ou ')})`,
      )
      return []
    }
    return [row]
  }

  const rows = []
  let offset = 0
  const statusEq = encodeURIComponent(INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR)
  while (rows.length < limit) {
    const batchLimit = Math.min(PAGE_SIZE, limit - rows.length)
    const q =
      `${table}?inscricao_form_status=eq.${statusEq}` +
      `&select=telefone,id_lead,eduit_deal_id,atendimento_ia,inscricao_form_status` +
      `&order=id.asc&limit=${batchLimit}&offset=${offset}`
    const r = await supabaseGet(url, key, q)
    if (!r.ok) {
      throw new Error(`Supabase list failed status=${r.status} ${String(r.raw || '').slice(0, 200)}`)
    }
    const batch = Array.isArray(r.data) ? r.data : []
    rows.push(...batch)
    if (batch.length < batchLimit) break
    offset += batch.length
  }
  return rows
}

/**
 * Tenta o chat_messages do Supabase e, se ele não tiver o dado que falta,
 * cai na conversa EduIT (caso Bianca #24067: o turno com o e-mail foi retido
 * pelo gate de pause e nunca virou histórico).
 */
async function resolveHistoryWithDado(telefone, leadId, snapshot) {
  const fontes = [
    { fonte: 'chat', load: () => readChatMessages(env, telefone, HISTORY_LIMIT) },
    {
      fonte: 'eduit',
      load: async () => {
        const r = await loadCrmRecentMessages(env, { telefone, limit: HISTORY_LIMIT })
        return Array.isArray(r?.messages) ? r.messages : []
      },
    },
  ]
  let ultimo = { historyMessages: [], fonte: 'chat', extracted: {}, plan: { written: [], values: {} } }
  for (const { fonte, load } of fontes) {
    const historyMessages = await load().catch(() => [])
    const extracted = extractCadastroFieldsFromInbound('', historyMessages, { phoneDigits: telefone })
    const plan = planWrites(extracted, snapshot)
    ultimo = { historyMessages, fonte, extracted, plan }
    if (plan.written.length) return ultimo
  }
  return ultimo
}

async function processLead(row, { apply, retryCaptacao, incluirCardCompleto }) {
  const telefone = normalizeTelefone(row.telefone)
  const statusAntes = String(row.inscricao_form_status || '').trim()
  const entry = {
    telefone,
    leadId: null,
    dealNumber: row.eduit_deal_id || row.id_lead || null,
    statusAntes,
    faltando: [],
    extraido: {},
    written: [],
    statusDepois: statusAntes,
  }

  if (!telefone) {
    entry.erro = 'telefone_vazio'
    return { ...entry, skip: 'erro' }
  }

  const leadId = await resolveCrmLeadId(env, telefone, row.eduit_deal_id || row.id_lead || null)
  entry.leadId = leadId || null
  if (!leadId) {
    entry.erro = 'lead_not_found'
    return { ...entry, skip: 'erro' }
  }

  const snapRes = await fetchLeadFormSnapshot(env, leadId)
  const snapshot = snapRes?.ok ? snapRes.snapshot || {} : {}
  const faltando = fieldsMissing(snapshot)
  entry.faltando = faltando

  if (!faltando.length) {
    entry.skip = 'card_completo'
    // Card em ordem — só a pausa ficou presa. Limpamos `atendimento_ia` mas
    // mantemos `distribuir_consultor`: esse status é terminal de propósito,
    // para não reabrir o loop do scheduler (caso CAIO SILVA).
    if (incluirCardCompleto) {
      if (apply) {
        await updateDadosCliente(env, { telefone, fields: { atendimento_ia: null } })
        entry.iaDestravada = true
      } else {
        entry.wouldUnlockIa = true
      }
    }
    if (retryCaptacao) {
      entry.retomada = apply
        ? await retomarCaptacao(telefone, leadId)
        : { dryRun: true, wouldCall: 'tryAdvanceInscricaoPostFormScheduler' }
    }
    return entry
  }

  const { historyMessages, fonte, extracted, plan } = await resolveHistoryWithDado(
    telefone,
    leadId,
    snapshot,
  )
  entry.fonteHistorico = fonte
  entry.extraido = {
    email: extracted.email || '',
    cpf: extracted.cpf || '',
    dataNasc: extracted.dataNasc || '',
    nome: extracted.nome || '',
  }

  if (!plan.written.length) {
    entry.skip = 'sem_dado_no_historico'
    return entry
  }

  if (!apply) {
    entry.written = plan.written
    entry.skip = null
    entry.statusDepois = INSCRICAO_FORM_STATUS_AGUARDANDO_DADOS_CADASTRO
    entry.wouldUnlock = true
    if (retryCaptacao) {
      entry.retomada = { dryRun: true, wouldCall: 'tryAdvanceInscricaoPostFormScheduler' }
    }
    return entry
  }

  const persist = await persistCadastroFieldsFromInbound(env, {
    telefone,
    leadId,
    userMessage: '',
    historyMessages,
  })
  entry.extraido = {
    email: persist.extracted?.email || '',
    cpf: persist.extracted?.cpf || '',
    dataNasc: persist.extracted?.dataNasc || '',
    nome: persist.extracted?.nome || '',
  }
  entry.written = Array.isArray(persist.written) ? persist.written : []
  entry.persistCode = persist.code || null
  entry.persistOk = Boolean(persist.ok)

  if (!entry.written.length) {
    entry.skip = 'sem_dado_no_historico'
    return entry
  }

  await updateDadosCliente(env, {
    telefone,
    fields: {
      atendimento_ia: null,
      inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_DADOS_CADASTRO,
    },
  })
  entry.statusDepois = INSCRICAO_FORM_STATUS_AGUARDANDO_DADOS_CADASTRO
  entry.skip = null
  entry.unlocked = true

  if (retryCaptacao) entry.retomada = await retomarCaptacao(telefone, leadId)

  return entry
}

async function retomarCaptacao(telefone, leadId) {
  try {
    const r = await tryAdvanceInscricaoPostFormScheduler(env, {
      telefone,
      leadId,
      forceCadastroRetry: true,
    })
    return {
      ok: Boolean(r?.ok),
      handled: Boolean(r?.handled),
      code: r?.code || r?.reason || null,
      replyPreview: r?.reply ? String(r.reply).slice(0, 120) : null,
    }
  } catch (err) {
    return { ok: false, erro: err?.message || String(err) }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const apply = args.apply
  const modo = apply ? 'apply' : 'dry'
  const { url, key, table } = getSupabase(env)
  if (!url || !key) {
    console.error('Configure SUPABASE_URL e SUPABASE_KEY')
    process.exit(1)
  }

  console.log(
    `[rescue-cadastro] modo=${modo} retryCaptacao=${args.retryCaptacao} limit=${args.limit}` +
      (args.telefone ? ` telefone=${args.telefone}` : ''),
  )

  const rows = await listDistribuirConsultorRows({
    url,
    key,
    table,
    limit: args.limit,
    telefone: args.telefone,
  })
  console.log(`[rescue-cadastro] candidatos=${rows.length}`)

  const leads = []
  const resumo = { resgatados: 0, sem_dado: 0, card_completo: 0, ia_destravada: 0, erros: 0 }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const tel = normalizeTelefone(row.telefone)
    try {
      const result = await processLead(row, {
        apply,
        retryCaptacao: args.retryCaptacao,
        incluirCardCompleto: args.incluirCardCompleto,
      })
      leads.push(result)

      if (result.erro || result.skip === 'erro') {
        resumo.erros += 1
        console.log(`  [${i + 1}/${rows.length}] ${tel} ERRO ${result.erro || 'desconhecido'}`)
      } else if (result.skip === 'card_completo') {
        resumo.card_completo += 1
        if (result.iaDestravada || result.wouldUnlockIa) resumo.ia_destravada += 1
        const iaBit = result.iaDestravada ? ' IA_DESTRAVADA' : result.wouldUnlockIa ? ' WOULD_UNLOCK_IA' : ''
        console.log(`  [${i + 1}/${rows.length}] ${tel} skip=card_completo leadId=${result.leadId}${iaBit}`)
      } else if (result.skip === 'sem_dado_no_historico') {
        resumo.sem_dado += 1
        console.log(
          `  [${i + 1}/${rows.length}] ${tel} skip=sem_dado_no_historico faltando=[${result.faltando.join(',')}]`,
        )
      } else {
        resumo.resgatados += 1
        const masked = maskExtraido(result.extraido)
        console.log(
          `  [${i + 1}/${rows.length}] ${tel} ${apply ? 'RESGATADO' : 'WOULD_RESCUE'}` +
            ` written=[${result.written.join(',')}]` +
            ` fonte=${result.fonteHistorico || '-'}` +
            ` email=${masked.email || '-'} cpf=${masked.cpf || '-'} dataNasc=${masked.dataNasc || '-'}` +
            ` status→${result.statusDepois}` +
            (result.retomada ? ` retomada=${JSON.stringify(result.retomada)}` : ''),
        )
      }
    } catch (err) {
      resumo.erros += 1
      const erro = err?.message || String(err)
      leads.push({
        telefone: tel,
        leadId: row.id_lead || null,
        statusAntes: row.inscricao_form_status || null,
        faltando: [],
        extraido: {},
        written: [],
        statusDepois: row.inscricao_form_status || null,
        erro,
      })
      console.log(`  [${i + 1}/${rows.length}] ${tel} ERRO ${erro}`)
    }

    if (i < rows.length - 1) {
      await sleep(apply ? INTER_LEAD_MS_APPLY : INTER_LEAD_MS_DRY)
    }
  }

  const out = {
    geradoEm: new Date().toISOString(),
    modo,
    retryCaptacao: args.retryCaptacao,
    incluirCardCompleto: args.incluirCardCompleto,
    total: leads.length,
    resumo,
    leads,
  }

  const dataDir = path.join(ROOT, 'data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  const outPath = path.join(dataDir, `rescue-cadastro-preso-${todayStamp()}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))

  console.log('\n=== RESUMO ===')
  console.log(JSON.stringify({ outPath, modo, ...resumo, total: leads.length }, null, 2))
  if (!apply) {
    console.log('\nDry-run ok. Rode com --apply para gravar card e destravar.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
