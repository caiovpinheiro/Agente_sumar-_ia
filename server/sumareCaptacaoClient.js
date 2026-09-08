/**
 * API Captação Sumaré — vestibular agora vai pelo portal novo
 * (matricula.sumare.edu.br / Softsy + api-inscricao-educsy).
 * O GET /api-ingresso/candidato/gerar fica só para transferência ou
 * SUMARE_INSCRICAO_PATH=legacy.
 *
 * Env:
 *   SUMARE_CAPTACAO_ENABLED=true
 *   SUMARE_CAPTACAO_BASE_URL=https://api-captacao.sumare.edu.br
 *   SUMARE_CAPTACAO_TOKEN=Bearer ...
 *   SUMARE_SOFTSY_LOGIN / SUMARE_SOFTSY_PASSWORD
 *   SUMARE_MATRICULA_PORTAL_URL=https://matricula.sumare.edu.br
 */

import { getDefaultTipoIngresso } from './inscricaoConfig.js'
import { matchPoloFromUserMessage, resolvePoloUnidadeCode } from '../libShared/sumarePoloCatalog.js'
import { resolveCursoOfertaFromDb } from './sumareCaptacaoCursoStore.js'
import {
  turnoFromCursoCodigo,
  normalizeModalidade,
  TURNO_SEMIPRESENCIAL,
} from '../libShared/cursoModalidade.js'
import {
  parseGerarCandidatoPayload,
  classifyGerarCandidatoOutcome,
} from '../libShared/captacaoGerarOutcome.js'
import {
  isSumareEducsyEnabled,
  runEducsyInscricaoWorkflow,
  buildMatriculaPagamentoUrl,
} from './sumareMatriculaEducsyClient.js'

export { parseGerarCandidatoPayload, classifyGerarCandidatoOutcome } from '../libShared/captacaoGerarOutcome.js'

export function isSumareCaptacaoEnabled(env = process.env) {
  if (String(env.SUMARE_CAPTACAO_ENABLED || '').trim().toLowerCase() === 'false') {
    return false
  }
  const token = env.SUMARE_CAPTACAO_TOKEN || env.SUMARE_CAPTACAO_BEARER || ''
  return Boolean(String(env.SUMARE_CAPTACAO_BASE_URL || '').trim() && token.trim())
}

function getConfig(env) {
  return {
    base: (env.SUMARE_CAPTACAO_BASE_URL || 'https://api-captacao.sumare.edu.br').replace(/\/+$/, ''),
    token: String(env.SUMARE_CAPTACAO_TOKEN || env.SUMARE_CAPTACAO_BEARER || '').trim(),
    portalBase: (
      env.SUMARE_CONTRATO_PORTAL_URL ||
      'https://sumare.edu.br/vem-pra-sumare/vestibular/contrato'
    ).replace(/\/+$/, ''),
  }
}

function authHeader(token) {
  const t = token.replace(/^Bearer\s+/i, '').trim()
  return `Bearer ${t}`
}

async function captacaoFetch(env, pathWithQuery, { method = 'GET', timeoutMs = 45_000 } = {}) {
  const { base, token } = getConfig(env)
  if (!token) {
    return { ok: false, code: 'CAPTACAO_NOT_CONFIGURED', error: 'SUMARE_CAPTACAO_TOKEN ausente' }
  }
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`
  const url = `${base}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: authHeader(token),
      },
      signal: controller.signal,
    })
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      raw: typeof raw === 'string' ? raw.slice(0, 800) : '',
    }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : e.message
    return { ok: false, code: 'CAPTACAO_FETCH_FAILED', error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Dígitos do CPF (11) ou vazio. */
export function normalizeCpf(input) {
  const d = String(input || '').replace(/\D/g, '')
  if (!d) return ''
  // Kommo costuma gravar CPF sem zero à esquerda (ex.: 06398542657 → 6398542657).
  if (d.length < 11) return d.padStart(11, '0')
  return d.slice(0, 11)
}

/** Formato exibido na API: (11) 94501-0493 */
export function formatCelularBrasil(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (d.length < 10) return ''
  const withCountry = d.length >= 12 && d.startsWith('55') ? d.slice(2) : d
  const ddd = withCountry.slice(0, 2)
  const rest = withCountry.slice(2)
  if (rest.length === 9) return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`
  if (rest.length === 8) return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`
  return `(${ddd}) ${rest}`
}

function normalizeCursoNomeKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function parseCursoMapEnv(env) {
  const raw = String(env.SUMARE_CAPTACAO_CURSO_MAP || '').trim()
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    const map = new Map()
    for (const [k, v] of Object.entries(obj)) {
      const code = String(v || '').trim().toUpperCase()
      if (code) map.set(normalizeCursoNomeKey(k), code)
    }
    return map.size ? map : null
  } catch {
    return null
  }
}

/** Nomes exibidos (sum_Curso) → código API Captação. Override via SUMARE_CAPTACAO_CURSO_MAP (JSON). */
const CURSO_NOME_TO_CODIGO = new Map(
  Object.entries({
    'administracao': 'ADM_EAD',
    'analise e desenvolvimento de sistemas': 'ADS_EAD',
    'ciencia da computacao': 'CCOMP_EAD',
    'ciencias contabeis': 'CCONT_EAD',
    'ciencias economicas': 'CECON_EAD',
    'engenharia civil': 'ECIV_EAD',
    'engenharia de producao': 'ENGP_EAD',
    'engenharia producao': 'ENGP_EAD',
    'fisioterapia': 'FISIO_EAD',
    'gestao financeira': 'GFIN_EAD',
    'historia': 'HIST_EAD',
    'jogos digitais': 'JOGOS_EAD',
    'marketing': 'MKT_EAD',
    'pedagogia': 'PED_EAD',
    'psicologia': 'PSI_EAD',
    'economia': 'ECON_EAD',
  }),
)

/** Código curso API (ex. ECON_EAD) — aceita valor já codificado, mapa por nome ou default env. */
export function resolveCursoCodigo(cursoInscricao, env = process.env) {
  const raw = String(cursoInscricao || '').trim()
  // Só tratar como código de API já pronto quando tiver o formato real
  // (token_token, ex.: GAST_EAD, ADM_EAD). Nomes humanos de curso como
  // "Gastronomia"/"Administração" devem cair no mapa/catálogo, não virar
  // código literal inexistente no Lyceum.
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/i.test(raw)) return raw.toUpperCase()
  const key = normalizeCursoNomeKey(raw)
  const fromEnv = parseCursoMapEnv(env)
  if (fromEnv?.has(key)) return fromEnv.get(key)
  if (CURSO_NOME_TO_CODIGO.has(key)) return CURSO_NOME_TO_CODIGO.get(key)
  const def = String(env.SUMARE_CAPTACAO_CURSO_DEFAULT || '').trim()
  return def ? def.toUpperCase() : ''
}

/** Cache da lista oficial de cursos EAD (transferência usa origem e destino dessa lista). */
let _cursosV2Cache = null
let _cursosV2CacheAt = 0

/** GET /api-ingresso/ead/academico/ingresso/cursosv2 — [{ curso, descricao }]. Cacheado 1h. */
export async function fetchCursosV2(env) {
  if (_cursosV2Cache && Date.now() - _cursosV2CacheAt < 3_600_000) return _cursosV2Cache
  const r = await captacaoFetch(env, '/api-ingresso/ead/academico/ingresso/cursosv2')
  if (r.ok && Array.isArray(r.data)) {
    _cursosV2Cache = r.data.map((c) => ({
      curso: String(c.curso || '').trim(),
      descricao: String(c.descricao || '').trim(),
    }))
    _cursosV2CacheAt = Date.now()
  }
  return _cursosV2Cache || []
}

/** Abreviações comuns citadas pelo lead → código EAD. */
const TRANSFERENCIA_CURSO_ALIASES = new Map(
  Object.entries({
    ads: 'ADS_EAD',
    adm: 'ADM_EAD',
    rh: 'RH_EAD',
    gti: 'GTI_EAD',
    sisinf: 'SISINF_EAD',
    ccomp: 'CCOMP_EAD',
    redes: 'REDES_EAD',
    mkt: 'MARK_EAD',
    marketing: 'MARK_EAD',
  }),
)

function resolveTransferenciaAlias(raw) {
  const compact = normalizeCursoNomeKey(raw).replace(/\s+/g, '')
  const code = TRANSFERENCIA_CURSO_ALIASES.get(compact)
  return code ? code.toUpperCase() : null
}

/**
 * Cursos EAD parecidos com o nome informado (para sugerir quando não há match exato).
 * @returns {Promise<Array<{ codigo: string, descricao: string, score: number }>>}
 */
export async function suggestSimilarTransferenciaCursos(env, input, limit = 4) {
  const key = normalizeCursoNomeKey(input)
  if (!key) return []
  const cursos = await fetchCursosV2(env)
  const tokens = key.split(/\s+/).filter((t) => t.length > 2)
  const scored = cursos.map((c) => {
    const ck = normalizeCursoNomeKey(c.descricao)
    let score = 0
    for (const t of tokens) {
      if (ck.includes(t)) score += 2
    }
    if (ck.includes(key) || key.includes(ck)) score += 3
    if (/seguranca|informacao|informatica|tecnologia|sistema|comput|rede|dado/i.test(key)) {
      if (/redes|informacao|comput|tecnologia|dado|internet/i.test(ck)) score += 1
      if (/seguranca/i.test(key) && /redes de computadores/i.test(ck)) score += 3
      if (/seguranca/i.test(key) && /ciencia da computacao/i.test(ck)) score += 2
    }
    return { codigo: c.curso, descricao: c.descricao, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
}

/**
 * Resolve um curso (nome humano ou código) para o código EAD oficial via cursosv2.
 * @returns {Promise<{ codigo: string, descricao: string }|null>}
 */
export async function resolveTransferenciaCursoCodigo(env, input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const cursos = await fetchCursosV2(env)
  // Já é um código (ex.: SISINF_EAD, PED_SEMI)
  if (/^[A-Z0-9]+_(?:EAD|SEMI)$/i.test(raw)) {
    const up = raw.toUpperCase()
    const hit = cursos.find((c) => c.curso.toUpperCase() === up)
    if (hit) return { codigo: hit.curso, descricao: hit.descricao }
    const ofertaCodigo = await resolveCursoOfertaFromDb(up, env)
    if (ofertaCodigo?.codigo) {
      return {
        codigo: ofertaCodigo.codigo,
        descricao: ofertaCodigo.descricao || ofertaCodigo.nome || up,
      }
    }
    return { codigo: up, descricao: up }
  }
  const aliasCode = resolveTransferenciaAlias(raw)
  if (aliasCode) {
    const hit = cursos.find((c) => c.curso.toUpperCase() === aliasCode)
    if (hit) return { codigo: hit.curso, descricao: hit.descricao }
  }
  const key = normalizeCursoNomeKey(raw)
  if (!key) return null
  let m = cursos.find((c) => normalizeCursoNomeKey(c.descricao) === key)
  if (!m) {
    m = cursos.find((c) => {
      const ck = normalizeCursoNomeKey(c.descricao)
      return ck === key || (key.length >= 12 && (ck.includes(key) || key.includes(ck)))
    })
  }
  if (!m) {
    const tokens = key.split(/\s+/).filter((t) => t.length > 2)
    if (tokens.length >= 2) {
      const ranked = cursos
        .map((c) => {
          const ck = normalizeCursoNomeKey(c.descricao)
          const hits = tokens.filter((t) => ck.includes(t)).length
          return { c, hits }
        })
        .filter((x) => x.hits >= 2)
        .sort((a, b) => b.hits - a.hits)
      if (ranked.length === 1 || (ranked.length > 1 && ranked[0].hits > ranked[1].hits)) {
        m = ranked[0].c
      }
    }
  }
  if (m) return { codigo: m.curso, descricao: m.descricao }

  const oferta = await resolveCursoOfertaFromDb(raw, env)
  if (oferta?.codigo) {
    return {
      codigo: oferta.codigo,
      descricao: oferta.descricao || oferta.nome || raw,
    }
  }
  const syncCode = resolveCursoCodigo(raw, env)
  if (syncCode) {
    const ofertaSync = await resolveCursoOfertaFromDb(syncCode, env)
    return {
      codigo: syncCode,
      descricao: ofertaSync?.descricao || ofertaSync?.nome || raw,
    }
  }
  return null
}

/** Parâmetros que a API exige na query mesmo vazios (espelha workflow n8n). */
export const GERAR_CANDIDATO_QUERY_DEFAULTS = {
  utmSource: '',
  utmCampaign: '',
  utmMedium: '',
  planoPgto: '',
  quemIndicou: '',
  localInscricao: '',
  dispositivo: '',
  raAntigo: '',
  cursoAntigo: '',
  instituicaoAntiga: '',
}

export function normalizeDataNasc(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (br) return `${br[3]}-${br[2]}-${br[1]}`
  const digits = s.replace(/\D/g, '')
  if (digits.length === 8) {
    const dd = digits.slice(0, 2)
    const mm = digits.slice(2, 4)
    const yyyy = digits.slice(4, 8)
    if (Number(dd) >= 1 && Number(dd) <= 31 && Number(mm) >= 1 && Number(mm) <= 12) {
      return `${yyyy}-${mm}-${dd}`
    }
  }
  return ''
}

/**
 * Detecta valor inválido em sum_Data Nascimento no Kommo (ex.: telefone gravado por engano).
 */
export function kommoDataNascLooksInvalid(raw, phoneDigits) {
  const s = String(raw || '').trim()
  if (!s) return true
  const digits = s.replace(/\D/g, '')
  if (!digits || digits.length < 8) return true
  const phone = String(phoneDigits || '').replace(/\D/g, '')
  if (phone && (digits === phone || digits === phone.slice(-11) || digits === phone.slice(-10))) {
    return true
  }
  if (
    /^\d{10,13}$/.test(digits) &&
    !/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(digits)
  ) {
    return true
  }
  return !normalizeDataNasc(raw)
}

export function normalizeSexo(input) {
  const s = String(input || '').trim().toUpperCase()
  if (s.startsWith('M')) return 'M'
  if (s.startsWith('F')) return 'F'
  return ''
}

/**
 * Extrai id do candidato da resposta da API (vários formatos possíveis).
 */
export function extractCandidatoId(payload) {
  if (payload == null) return null
  if (typeof payload === 'string' || typeof payload === 'number') {
    const s = String(payload).trim()
    return s.length >= 8 ? s : null
  }
  const candidates = [
    payload.candidato,
    payload.candidatoId,
    payload.candidato_id,
    payload.id,
    payload.idCandidato,
    payload?.data?.candidato,
    payload?.data?.id,
    payload?.result?.candidato,
  ]
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim()
  }
  return null
}

/** URL do portal (tela Termos de Contrato + ASSINAR CONTRATO). */
export function buildContratoPortalUrl(env, candidatoId) {
  const id = String(candidatoId || '').trim()
  if (!id) return ''
  const base = getConfig(env).portalBase
  return `${base}?id=${encodeURIComponent(id)}`
}

/** URL do portal na etapa de pagamento (meioPagamento). */
export function buildMeioPagamentoPortalUrl(env, candidatoId) {
  const id = String(candidatoId || '').trim()
  if (!id) return ''
  const contratoBase = getConfig(env).portalBase.replace(/\/+$/, '')
  const vestibularBase = contratoBase.replace(/\/contrato\/?$/i, '')
  return `${vestibularBase}/meioPagamento?id=${encodeURIComponent(id)}`
}

export function extractCandidatoStatusString(statusPayload) {
  if (!statusPayload || typeof statusPayload !== 'object') return null
  const raw = statusPayload.status ?? statusPayload.candidato?.status ?? null
  const s = raw != null ? String(raw).trim() : ''
  return s || null
}

/** Candidato já passou da etapa de aceite no portal (API status). */
export function statusImpliesPagamentoPhase(statusStr) {
  const s = String(statusStr || '').toLowerCase()
  if (!s) return false
  return s.includes('meiopagamento') || s === 'pagamento' || s.includes('pagamento')
}

/**
 * URL do portal a enviar ao candidato.
 *
 * Portal oficial: matricula.sumare.edu.br/Vestibular/pagamento?cpf=&utm_campaign=
 * (HAR 2026-09-01). O CPF é a chave; o código 2026… sozinho não abre o cadastro.
 *
 * @returns {{ url: string, phase: 'contrato'|'pagamento' }}
 */
export function resolvePortalUrlForCandidato(env, candidatoId, statusStr, extras = {}) {
  const phase = statusImpliesPagamentoPhase(statusStr) ? 'pagamento' : 'contrato'
  const cpf = normalizeCpf(extras.cpf || extras.snapshot?.cpf)
  if (cpf) return { url: buildMatriculaPagamentoUrl(env, { cpf }), phase: 'pagamento' }
  return { url: '', phase }
}

function extractUrlFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const urls = [
    payload.url,
    payload.link,
    payload.linkAceite,
    payload.link_aceite,
    payload.linkContrato,
    payload?.data?.url,
    payload?.data?.link,
  ]
  for (const u of urls) {
    const s = String(u || '').trim()
    if (/^https?:\/\//i.test(s)) return s
  }
  return ''
}

/**
 * Monta query string do GET /api-ingresso/candidato/gerar
 */
export function buildGerarCandidatoQuery(snapshot, telefone, env = process.env) {
  const fone = formatCelularBrasil(telefone)
  const cpf = normalizeCpf(snapshot?.cpf)
  const curso = resolveCursoCodigo(snapshot?.curso_inscricao, env)
  let unidade = String(snapshot?.unidade || '').trim().toUpperCase()
  if (!/^ED_SP_/i.test(unidade) && snapshot?.polo_inscricao) {
    const matched = matchPoloFromUserMessage(snapshot.polo_inscricao)
    if (matched) unidade = resolvePoloUnidadeCode(matched.id, env)
  }
  if (!unidade) {
    unidade = String(env.SUMARE_CAPTACAO_UNIDADE_DEFAULT || 'ED_SP_P5').trim()
  }
  const turno = String(snapshot?.turno || env.SUMARE_CAPTACAO_TURNO_DEFAULT || 'EAD').trim()
  const dataNasc =
    normalizeDataNasc(snapshot?.data_nasc) ||
    String(env.SUMARE_CAPTACAO_DATA_NASC_DEFAULT || '').trim()
  const sexo =
    normalizeSexo(snapshot?.sexo) || String(env.SUMARE_CAPTACAO_SEXO_DEFAULT || 'M').trim()
  const tipoIngresso = String(
    snapshot?.tipo_inscricao || getDefaultTipoIngresso(env),
  ).trim()

  const params = {
    ...GERAR_CANDIDATO_QUERY_DEFAULTS,
    cpf,
    celular: fone,
    nomeCompl: String(snapshot?.nome || '').trim(),
    email: String(snapshot?.email || '').trim(),
    dataNasc,
    sexo,
    curso,
    turno,
    unidade,
    tipoIngresso,
    sumareComVc: 'N',
  }

  // Ingresso por TRANSFERÊNCIA EXTERNA / aproveitamento de matérias.
  // Espelha o frontend (dadosExternos.js): mesmo endpoint `gerar`, mudando
  // tipoIngresso=Transferencia_Ext, cursoAntigo=curso de origem e a SÉRIE
  // (último semestre concluído) carregada no campo `dispositivo`.
  // ⚠️ "Transferência Externa" (acento/espaço) estoura a coluna no SQL Server.
  applyTransferenciaParams(params, snapshot, env)

  return params
}

/** True quando o snapshot indica ingresso por transferência externa. */
export function isTransferenciaSnapshot(snapshot) {
  if (!snapshot) return false
  if (String(snapshot.transferencia_curso_origem || '').trim()) return true
  return /transfer/i.test(String(snapshot.tipo_inscricao || ''))
}

/** Sobrescreve params do `gerar` para o fluxo de transferência (mutação in-place). */
export function applyTransferenciaParams(params, snapshot, env = process.env) {
  if (!isTransferenciaSnapshot(snapshot)) return params
  params.tipoIngresso = 'Transferencia_Ext'
  const origem = resolveCursoCodigo(snapshot?.transferencia_curso_origem, env)
  if (origem) params.cursoAntigo = origem
  const serie = String(snapshot?.transferencia_semestre || '').replace(/\D/g, '')
  if (serie) params.dispositivo = serie
  return params
}

/**
 * Igual a buildGerarCandidatoQuery, mas resolve curso + turno pela oferta oficial
 * (planilha) no Supabase. Garante que cursos Semipresenciais (ex.: Farmácia) sejam
 * enviados com o código `_SEMI` e turno=SEMIPRESENCIAL — combinação que a API
 * exige para gerar o financeiro (senão o portal mostra "R$ null/mês").
 */
export async function buildGerarCandidatoQueryAsync(snapshot, telefone, env = process.env) {
  const params = buildGerarCandidatoQuery(snapshot, telefone, env)
  const explicitTurno = String(snapshot?.turno || '').trim()

  const oferta = await resolveCursoOfertaFromDb(snapshot?.curso_inscricao, env)
  if (oferta?.codigo) {
    const mod = normalizeModalidade(oferta.modalidade)
    if (mod === 'Semipresencial') {
      // Caso quebrado: a oferta oficial é Semipresencial. Força o código `_SEMI`
      // e turno=SEMIPRESENCIAL (sobrescreve qualquer `_EAD` herdado do mapa/env).
      params.curso = oferta.codigo
      if (!explicitTurno) params.turno = oferta.turno || TURNO_SEMIPRESENCIAL
      return params
    }
    // EAD/indefinida: só completa o curso se o resolvedor síncrono não tiver achado
    // (preserva o mapeamento EAD já validado e evita trocar por variante errada).
    if (!params.curso) {
      params.curso = oferta.codigo
      if (!explicitTurno && oferta.turno) params.turno = oferta.turno
    }
    return params
  }

  // Sem oferta resolvida: mantém curso do mapa/env e alinha o turno ao sufixo do código.
  if (params.curso && !explicitTurno) {
    const t = turnoFromCursoCodigo(params.curso)
    if (t) params.turno = t
  }
  return params
}

export function validateGerarCandidatoParams(params) {
  const missing = []
  if (!params.cpf) missing.push('cpf')
  if (!params.celular) missing.push('celular')
  if (!params.nomeCompl) missing.push('nome')
  if (!params.email) missing.push('email')
  if (!params.curso) missing.push('curso')
  if (!params.unidade) missing.push('unidade')
  if (!params.dataNasc) missing.push('dataNasc')
  if (!params.sexo) missing.push('sexo')
  return missing
}

/**
 * GET /api-ingresso/candidato/gerar?...
 */
export async function gerarCandidatoIngresso(env, params) {
  const merged = { ...GERAR_CANDIDATO_QUERY_DEFAULTS, ...params }
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(merged)) {
    if (val == null) continue
    qs.set(key, String(val).trim())
  }
  return captacaoFetch(env, `/api-ingresso/candidato/gerar?${qs.toString()}`)
}

/**
 * GET /api-status-candidato/candidato/status?candidato=
 */
export async function consultarStatusCandidato(env, candidatoId) {
  const id = encodeURIComponent(String(candidatoId))
  return captacaoFetch(env, `/api-status-candidato/candidato/status?candidato=${id}`)
}

/**
 * GET /api-contrato-ingresso/contrato/ingresso/aceite?candidato=
 */
export async function solicitarAceiteContrato(env, candidatoId) {
  const id = encodeURIComponent(String(candidatoId))
  return captacaoFetch(env, `/api-contrato-ingresso/contrato/ingresso/aceite?candidato=${id}`)
}

/**
 * Fluxo completo: gerar → status → aceite → URL do portal.
 */
export async function runCaptacaoContratoWorkflow(env, { snapshot, telefone, captacaoContext = {} }) {
  const steps = []
  const params = await buildGerarCandidatoQueryAsync(snapshot, telefone, env)
  const missing = validateGerarCandidatoParams(params)
  const requestedCurso = {
    nome: String(snapshot?.curso_inscricao || '').trim(),
    codigo: params.curso,
  }
  if (missing.length) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      missing,
      steps,
      error: `Dados insuficientes para inscrição Sumaré: ${missing.join(', ')}`,
    }
  }

  const priorCandidatoId = String(captacaoContext.priorCandidatoId || '').trim()
  const priorCursoCodigo = String(captacaoContext.priorCursoCodigo || '').trim().toUpperCase()
  const confirmedNovaInscricao = Boolean(captacaoContext.confirmedNovaInscricao)
  const useCandidatoId = String(captacaoContext.useCandidatoId || '').trim()

  if (
    priorCandidatoId &&
    priorCursoCodigo &&
    params.curso &&
    priorCursoCodigo !== params.curso.toUpperCase() &&
    !confirmedNovaInscricao &&
    !useCandidatoId
  ) {
    return {
      ok: false,
      code: 'NEEDS_CONFIRM_NOVA_INSCRICAO',
      steps,
      priorCandidatoId,
      priorCursoCodigo,
      priorCursoNome: captacaoContext.priorCursoNome || null,
      requestedCurso,
      error: 'Candidato já possui inscrição em outro curso — confirmação necessária',
    }
  }

  const inscricaoPath = String(env.SUMARE_INSCRICAO_PATH || 'educsy').trim().toLowerCase()
  const forceLegacy =
    inscricaoPath === 'legacy' || inscricaoPath === 'captacao' || inscricaoPath === 'gerar'
  if (!forceLegacy && !isTransferenciaSnapshot(snapshot)) {
    if (!isSumareEducsyEnabled(env)) {
      return {
        ok: false,
        code: 'SOFTSY_NOT_CONFIGURED',
        steps,
        error:
          'Inscrição do portal novo exige SUMARE_SOFTSY_LOGIN e SUMARE_SOFTSY_PASSWORD',
        requestedCurso,
      }
    }
    if (!useCandidatoId) {
      const educsy = await runEducsyInscricaoWorkflow(env, { snapshot, params, telefone })
      return {
        ...educsy,
        requestedCurso: educsy.requestedCurso || requestedCurso,
        gerarOutcome: educsy.gerarOutcome || null,
      }
    }
  }

  let candidatoId = useCandidatoId || null
  let gerar = { ok: true, data: null, status: null, skipped: Boolean(useCandidatoId) }

  if (!candidatoId) {
    gerar = await gerarCandidatoIngresso(env, params)
    steps.push({ step: 'gerar_candidato', ok: gerar.ok, status: gerar.status })
    if (!gerar.ok) {
      return {
        ok: false,
        code: 'GERAR_FAILED',
        steps,
        error: gerar.error || gerar.raw || `HTTP ${gerar.status}`,
        priorCandidatoId: priorCandidatoId || null,
        requestedCurso,
      }
    }

    candidatoId = extractCandidatoId(gerar.data)
    if (!candidatoId && typeof gerar.data === 'string') {
      candidatoId = extractCandidatoId(gerar.data.trim())
    }
  } else {
    steps.push({ step: 'gerar_candidato', ok: true, skipped: true, candidatoId })
  }

  if (!candidatoId) {
    return {
      ok: false,
      code: 'CANDIDATO_ID_MISSING',
      steps,
      error: 'API gerar candidato não retornou id do candidato',
      raw: gerar.raw,
    }
  }

  const gerarParsed = parseGerarCandidatoPayload(gerar.data)
  const gerarOutcome = classifyGerarCandidatoOutcome(gerarParsed, requestedCurso)
  steps.push({
    step: 'gerar_outcome',
    kind: gerarOutcome.kind,
    pagina: gerarParsed?.pagina,
    sameCourse: gerarOutcome.sameCourse,
    cursoApi: gerarParsed?.cursoCodigo,
  })

  if (gerarOutcome.kind === 'multiple_inscricoes_portal') {
    return {
      ok: false,
      code: 'MULTIPLE_INSCRICOES_PORTAL',
      steps,
      candidatoId,
      gerarOutcome,
      requestedCurso,
      portalCandidatoUrl: buildPortalCandidatoSelecaoUrl(env),
      error: 'Várias inscrições existentes — confirmação no portal',
    }
  }

  if (
    gerarOutcome.kind === 'different_course_new' &&
    priorCandidatoId &&
    priorCandidatoId !== candidatoId &&
    !confirmedNovaInscricao
  ) {
    return {
      ok: false,
      code: 'NEEDS_CONFIRM_NOVA_INSCRICAO',
      steps,
      candidatoId,
      priorCandidatoId,
      priorCursoCodigo,
      priorCursoNome: captacaoContext.priorCursoNome || null,
      requestedCurso,
      gerarOutcome,
      error: 'Nova inscrição criada em curso diferente — aguardando confirmação do lead',
    }
  }

  const statusAfterGerar = await consultarStatusCandidato(env, candidatoId)
  const statusStrGerar = extractCandidatoStatusString(statusAfterGerar.data)
  steps.push({
    step: 'status_candidato',
    ok: statusAfterGerar.ok,
    status: statusAfterGerar.status,
    candidatoId,
    apiStatus: statusStrGerar,
  })

  const sameCourseInProgress = gerarOutcome.kind === 'same_course_in_progress'

  let aceite = { ok: true, skipped: true, data: null, status: null }
  if (!statusImpliesPagamentoPhase(statusStrGerar) && !sameCourseInProgress) {
    aceite = await solicitarAceiteContrato(env, candidatoId)
    steps.push({ step: 'aceite_contrato', ok: aceite.ok, status: aceite.status })
  } else {
    steps.push({
      step: 'aceite_contrato',
      ok: true,
      skipped: true,
      reason: sameCourseInProgress
        ? 'same_course_already_in_payment'
        : 'already_meio_pagamento_after_gerar',
    })
  }

  const statusFinal = await consultarStatusCandidato(env, candidatoId)
  const statusStrFinal =
    extractCandidatoStatusString(statusFinal.data) || statusStrGerar || null
  steps.push({
    step: 'status_pos_aceite',
    ok: statusFinal.ok,
    apiStatus: statusStrFinal,
  })

  const portalResolved = resolvePortalUrlForCandidato(env, candidatoId, statusStrFinal, {
    cpf: params.cpf,
  })
  let contractUrl = extractUrlFromPayload(aceite.data)
  if (!contractUrl || !/^https?:\/\//i.test(contractUrl) || /sumare\.edu\.br\/vem-pra-sumare/i.test(contractUrl) || /meiopagamento/i.test(contractUrl)) {
    contractUrl = portalResolved.url || buildMatriculaPagamentoUrl(env, { cpf: params.cpf })
  }

  if (!aceite.ok && !aceite.skipped) {
    console.warn(
      `[sumareCaptacao] aceite HTTP ${aceite.status} — usando link portal fallback candidato=${candidatoId} phase=${portalResolved.phase}`,
    )
  }

  return {
    ok: true,
    candidatoId,
    contractUrl,
    portalPhase: portalResolved.phase,
    candidatoStatus: statusStrFinal,
    gerarOutcome,
    sameCourseInProgress,
    requestedCurso,
    cursoCodigo: gerarParsed?.cursoCodigo || params.curso,
    cursoNome: gerarParsed?.nomeCurso || requestedCurso.nome,
    steps,
    gerar: gerar.data,
    status: statusFinal.data,
    aceite: aceite.data,
  }
}

/** URL do portal quando há várias inscrições (tela "Gostaria de continuar?"). */
export function buildPortalCandidatoSelecaoUrl(env) {
  const contratoBase = getConfig(env).portalBase.replace(/\/+$/, '')
  const vestibularBase = contratoBase.replace(/\/contrato\/?$/i, '')
  return `${vestibularBase.replace(/\/vestibular\/?$/i, '')}/candidato`
}
