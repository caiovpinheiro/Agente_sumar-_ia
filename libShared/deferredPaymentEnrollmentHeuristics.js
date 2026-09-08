/**
 * Lead quer iniciar inscrição/matrícula agora, mas pagar em data futura.
 * Também: pós-link (aguardando pagamento) — adiar reenvio quando a data é futura.
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'

function normalizeDeferralText(text) {
  return normalizeMessageForScope(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/** Lead pergunta se pode fazer o processo hoje e pagar depois (ex.: dia 30). */
export function messageAsksDeferredPaymentEnrollment(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t || t.length < 20) return false

  const paymentLater =
    /\b(s[oó]\s+(vou|posso|consigo)\s+pagar|pagar\s+(s[oó]|apenas|somente|no\s+dia|dia\s+\d|depois|mais\s+tarde|posteriormente)|pagamento\s+(no\s+dia|dia\s+\d|depois|posterior|mais\s+tarde)|executar\s+o\s+pagamento|ter\s+(um\s+)?valor\s+(s[oó]|no\s+dia|dia\s+\d))\b/i.test(
      t,
    ) ||
    /\b(daqui\s+a\s+\d+\s+dias?|no\s+dia\s+\d{1,2}(?:\s+deste\s+m[eê]s)?)\b/i.test(t)

  const enrollmentNow =
    /\b(fazer\s+(todo\s+)?(o\s+)?processo|garantir\s+(a\s+)?vaga|matr[ií]cula|inscri[cç][aã]o|fechamos|libera[cç][aã]o\s+do\s+curso|processo\s+hoje|processo\s+hj)\b/i.test(
      t,
    )

  if (paymentLater && enrollmentNow) return true
  if (/\bvalor\s+promocional\b/i.test(t) && paymentLater) return true

  return false
}

/** Resposta canônica — matrícula só na data do pagamento; valores podem mudar. */
export function buildDeferredPaymentEnrollmentReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  return (
    `Entendo${nameBit}! Como o pagamento será executado em uma data posterior, os valores podem sofrer alterações ` +
    `por decisões internas da Faculdade Sumaré.\n\n` +
    `Mesmo assim, faremos o possível para garantir o valor promocional que combinamos.\n\n` +
    `Quando você estiver pronto(a) para efetuar o pagamento, é só entrar em contato por aqui — ` +
    `realizamos sua matrícula naquele momento. Não é necessário concluir todo o processo hoje sem o pagamento.`
  )
}

/** Partes do calendário civil em America/Sao_Paulo. */
export function getSaoPauloYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now instanceof Date ? now : new Date(now))
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value)
  const d = Number(parts.find((p) => p.type === 'day')?.value)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return { y, m, d }
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function ymdCompare(a, b) {
  if (a.y !== b.y) return a.y - b.y
  if (a.m !== b.m) return a.m - b.m
  return a.d - b.d
}

function addDaysSaoPaulo(today, days) {
  const utcNoon = Date.UTC(today.y, today.m - 1, today.d, 15, 0, 0)
  const next = new Date(utcNoon + days * 24 * 60 * 60 * 1000)
  return getSaoPauloYmd(next)
}

/**
 * Próxima ocorrência estritamente futura de `dia N` (sem mês).
 * Dia = hoje → não é futura (retorna null). Dia inválido neste mês → tenta o seguinte.
 */
function resolveNextFutureDayOfMonth(day, today) {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null
  if (day === today.d) return null
  if (day > today.d) {
    const dim = daysInMonth(today.y, today.m)
    if (day <= dim) return { y: today.y, m: today.m, d: day }
  }
  let y = today.y
  let m = today.m + 1
  if (m > 12) {
    m = 1
    y += 1
  }
  const dim = daysInMonth(y, m)
  if (day > dim) return null
  const cand = { y, m, d: day }
  if (ymdCompare(cand, today) <= 0) return null
  return cand
}

/**
 * Extrai data futura mencionada para pagamento.
 * Aceita `dia N`, `DD/MM` (opcional /AAAA) e `daqui a N dias`.
 * @returns {{ mentionedLabel: string, y: number, m: number, d: number }|null}
 */
export function extractFuturePaymentDateFromText(text, now = new Date()) {
  const raw = String(text || '')
  const t = normalizeDeferralText(raw)
  if (!t) return null
  const today = getSaoPauloYmd(now)
  if (!today) return null

  const daqui = t.match(/\bdaqui\s+a\s+(\d{1,3})\s+dias?\b/i)
  if (daqui) {
    const n = Number(daqui[1])
    if (Number.isInteger(n) && n >= 1 && n <= 366) {
      const target = addDaysSaoPaulo(today, n)
      if (target && ymdCompare(target, today) > 0) {
        const mentionedLabel = daqui[0].replace(/\s+/g, ' ').trim()
        return { mentionedLabel, ...target }
      }
    }
  }

  const dm = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (dm) {
    const day = Number(dm[1])
    const month = Number(dm[2])
    let year = dm[3] != null ? Number(dm[3]) : today.y
    if (dm[3] != null && dm[3].length === 2) year = 2000 + year
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const dim = daysInMonth(year, month)
      if (day <= dim) {
        let cand = { y: year, m: month, d: day }
        if (dm[3] == null && ymdCompare(cand, today) <= 0) {
          cand = { y: year + 1, m: month, d: day }
        }
        if (ymdCompare(cand, today) > 0) {
          return { mentionedLabel: dm[0], ...cand }
        }
      }
    }
  }

  const diaN = t.match(/\b(?:no\s+)?dia\s+(\d{1,2})\b/i)
  if (diaN) {
    const day = Number(diaN[1])
    const cand = resolveNextFutureDayOfMonth(day, today)
    if (cand) {
      return { mentionedLabel: `dia ${day}`, ...cand }
    }
  }

  return null
}

/**
 * Pós-link: lead indica que só poderá pagar / quer boleto só em data futura.
 * Não cobre comprovante nem "já paguei".
 */
export function messageAsksFutureMatriculaPaymentDeferral(text, now = new Date()) {
  const t = normalizeDeferralText(text)
  if (!t || t.length < 8) return false
  if (/\b(paguei|ja\s+paguei|efetuei\s+o\s+pagamento|comprovante)\b/i.test(t)) return false

  const parsed = extractFuturePaymentDateFromText(text, now)
  if (!parsed) return false

  if (/\breceber(?:ei|o)?\s+so\b/i.test(t)) return true
  if (/\bso\s+(vou|posso|consigo)\s+(ter\s+(um\s+)?valor|pagar|receber)\b/i.test(t)) return true
  if (/\bso\s+consigo\s+pagar\b/i.test(t)) return true
  if (/\b(vou|posso|consigo)\s+pagar\s+(so|apenas|somente|no\s+dia|dia\s+\d|\d{1,2}\/\d{1,2})\b/i.test(t))
    return true
  if (/\bpagar\s+(so|apenas|somente)\s+(no\s+)?dia\s+\d/i.test(t)) return true
  if (/\bpagamento\s+(so|apenas|somente|no\s+dia|dia\s+\d)/i.test(t)) return true
  if (
    /\b(manda|mande|envia|envie|enviar|me\s+manda)\b[\s\S]{0,50}\b(boleto|link|pagamento)\b[\s\S]{0,50}\b(dia|\d{1,2}\/\d{1,2})\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (
    /\b(boleto|link)\b[\s\S]{0,40}\b(para\s+o\s+dia|pro\s+dia|pra\s+dia|no\s+dia|dia\s+\d|\d{1,2}\/\d{1,2})\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Resolve deferral pós-link com a data mencionada (label fiel ao texto).
 * @returns {{ mentionedLabel: string, y: number, m: number, d: number }|null}
 */
export function resolveFutureMatriculaPaymentDeferral(text, now = new Date()) {
  if (!messageAsksFutureMatriculaPaymentDeferral(text, now)) return null
  return extractFuturePaymentDateFromText(text, now)
}

function formatDeferralDatePhrase(dateLabel) {
  const s = String(dateLabel || '').trim()
  if (!s) return 'nessa data'
  if (/^dia\s+\d/i.test(s)) return `no ${s}`
  if (/^daqui\s+a\s+/i.test(s)) return s
  if (/^\d{1,2}\/\d{1,2}/.test(s)) return `no dia ${s}`
  return `em ${s}`
}

/** Resposta canônica — não reenvia link; orienta retorno na data. */
export function buildFutureMatriculaPaymentDeferralReply(opts = {}) {
  const nameBit = opts.pushName ? `, ${String(opts.pushName).split(/\s+/)[0]}` : ''
  const dateLabel = String(opts.dateLabel || opts.mentionedLabel || '').trim()
  const whenBit = formatDeferralDatePhrase(dateLabel)
  return (
    `Entendo${nameBit}! Sem problema — ${whenBit} você pode entrar em contato novamente por aqui, ` +
    `e então encaminhamos o *link do portal* para o pagamento da matrícula ` +
    `(nele você escolhe PIX, boleto ou cartão).\n\n` +
    `Quando estiver pronto(a) nessa data, é só chamar por aqui.`
  )
}
