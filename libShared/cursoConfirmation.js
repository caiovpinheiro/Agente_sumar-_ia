/**
 * Detecta quando o candidato CONFIRMA interesse num curso específico
 * durante a conversa. Usado para popular o campo sum_Curso no Kommo
 * antes do formulário/matrícula.
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'
import {
  extractDiscussedCourseFromHistory,
  lastAssistantText,
} from './conversationContextHeuristics.js'
import { SUMARE_POLOS_EAD } from './sumarePoloCatalog.js'

function normalizePoloCompare(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/** Nome de polo EAD/Central — nunca deve ser gravado como curso. */
export function isPoloNameLike(text) {
  const n = normalizePoloCompare(text)
  if (!n) return false
  if (n === 'pinheiros' || n === 'central' || n === 'barra funda') return true
  for (const p of SUMARE_POLOS_EAD) {
    if (normalizePoloCompare(p.nome) === n) return true
    for (const alias of p.aliases || []) {
      if (normalizePoloCompare(alias) === n) return true
    }
  }
  return false
}

function assistantTextLooksLikePoloList(assist) {
  const a = String(assist || '')
  if (/n[aã]o consegui identificar o polo/i.test(a)) return true
  if (/\bpolos?\s+de\s+apoio\s+presencial/i.test(a)) return true
  if (/\bpolo\b/i.test(a)) {
    const norm = normalizePoloCompare(a)
    let hits = 0
    for (const p of SUMARE_POLOS_EAD) {
      const nome = normalizePoloCompare(p.nome)
      if (nome && norm.includes(nome)) hits += 1
    }
    if (hits >= 2) return true
  }
  return false
}

const STOP_WORDS = new Set([
  'esse', 'essa', 'isso', 'sim', 'nao', 'não', 'ok', 'okay', 'matricula',
  'matrícula', 'inscricao', 'inscrição', 'curso', 'cursos', 'faculdade',
  'sumare', 'sumaré', 'agora', 'voce', 'você', 'eu', 'que', 'pode',
  'bora', 'vamos', 'ai', 'aí', 'me', 'um', 'uma', 'o', 'a', 'de', 'do', 'da',
])

const CURSO_PATTERNS = [
  /\b(fisioterapia)\b/i,
  /\b(enfermagem)\b/i,
  /\b(administra[cç][aã]o|administração)\b/i,
  /\b(pedagogia)\b/i,
  /\b(direito)\b/i,
  /\b(psicologia)\b/i,
  /\b(engenharia\s+(?:civil|de\s+produ[cç][aã]o|el[eé]trica|mec[aâ]nica|computa[cç][aã]o|software|de\s+software)?)\b/i,
  /\b(arquitetura(?:\s+e\s+urbanismo)?)\b/i,
  /\b(nutri[cç][aã]o)\b/i,
  /\b(farm[aá]cia)\b/i,
  /\b(biomedicina)\b/i,
  /\b(odontologia)\b/i,
  /\b(medicina(?:\s+veterin[aá]ria)?)\b/i,
  /\b(gastronomia)\b/i,
  /\b(ci[eê]ncias?\s+(?:cont[aá]beis|econ[oô]micas|biol[oó]gicas|sociais|da\s+computa[cç][aã]o))\b/i,
  /\b(economia)\b/i,
  /\b(contabilidade|contabeis|cont[aá]beis)\b/i,
  /\b(marketing(?:\s+digital)?)\b/i,
  /\b(publicidade(?:\s+e\s+propaganda)?)\b/i,
  /\b(jornalismo)\b/i,
  /\b(servi[cç]o\s+social)\b/i,
  /\b(educa[cç][aã]o\s+f[ií]sica)\b/i,
  /\b(letras|hist[oó]ria|geografia|filosofia|sociologia|matem[aá]tica|f[ií]sica|qu[ií]mica|biologia)\b/i,
  /\b(rh|recursos\s+humanos|gest[aã]o\s+de\s+pessoas)\b/i,
  /\b(log[ií]stica|gest[aã]o\s+comercial|gest[aã]o\s+financeira|com[eé]rcio\s+exterior)\b/i,
  /\b(an[aá]lise\s+e?\s+desenvolvimento\s+de\s+sistemas|ads)\b/i,
  /\b(redes\s+de\s+computadores|seguran[cç]a\s+da\s+informa[cç][aã]o)\b/i,
  /\b(est[eé]tica(?:\s+e\s+cosm[eé]tica)?)\b/i,
]

function titleCase(text) {
  return String(text)
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => {
      if (!/[a-zà-ÿ]/i.test(part)) return part
      if (['de', 'da', 'do', 'das', 'dos', 'e'].includes(part)) return part
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

const CURSO_NAME_STOP_TOKENS = new Set([
  'tem', 'é', 'fica', 'custa', 'esta', 'está', 'sai', 'com', 'por',
  'que', 'no', 'na', 'nos', 'nas', 'em', 'para', 'pra',
  'também', 'tambem', 'incluso', 'presencial', 'ead', 'semi',
  'online', 'noturno', 'matutino', 'integral', 'vagas', 'vaga',
  'polo', 'polos', 'mensalidade', 'mensalidades', 'preço', 'preco',
  'valor', 'valores', 'graduação', 'graduacao', 'graduacão',
  'tecnologo', 'tecnólogo', 'bacharel', 'licenciatura', 'whatsapp',
])

/**
 * Corta o nome no primeiro token "de lixo" (verbo/modalidade/preço…).
 * Mantém conectivos `e/de/da/do/das/dos` para nomes compostos como
 * "Análise e Desenvolvimento de Sistemas" e pós longas
 * ("Educação Infantil e Desenvolvimento da Linguagem").
 */
function sanitizeCursoName(rawName) {
  if (!rawName) return ''
  const text = String(rawName).trim().replace(/[.,;:!?]+$/g, '')
  const tokens = text.split(/\s+/).filter(Boolean)
  const kept = []
  for (const tok of tokens) {
    const t = tok.toLowerCase()
    if (CURSO_NAME_STOP_TOKENS.has(t)) break
    kept.push(tok)
    if (kept.length >= 12) break
  }
  if (kept.length === 0) return ''
  const limited = kept.join(' ')
  if (limited.length < 3) return ''
  if (STOP_WORDS.has(limited.toLowerCase())) return ''
  return titleCase(limited)
}

/** Nome de área/curso citado no texto (ex.: "recursos humanos", "marketing"). */
export function extractCursoAreaFromText(text) {
  const raw = String(text || '')
  for (const re of CURSO_PATTERNS) {
    const m = raw.match(re)
    if (m?.[1]) return titleCase(m[1])
  }
  return ''
}

function extractCursoFromText(text) {
  return extractCursoAreaFromText(text)
}

function userExpressesInterest(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t) return false
  return (
    /\b(quero|gostaria|gostei|vou\s+fazer|pretendo|preciso|posso\s+fazer|tenho\s+interesse)\b/i.test(t) ||
    /\b(me\s+inscrev|matricul|inscri[cç][aã]o)\b/i.test(t) ||
    /\b(esse|essa|isso)\s+curso\b/i.test(t)
  )
}

/**
 * Narrativa inequívoca de formação anterior/atual (cursei, estou cursando…),
 * sem verbo explícito de destino/interesse. Não deve confirmar curso desejado.
 * "Cursei Pedagogia e quero Administração" NÃO é só formação passada.
 */
export function isPastOrCurrentFormationWithoutDestination(text) {
  const t = normalizeMessageForScope(text).toLowerCase()
  if (!t) return false
  const hasPastCurrent =
    /\b(cursei|cursava|estudei|(?:j[aá]\s+)?fiz|(?:estou|estava)\s+cursando|cursando)\b/i.test(t)
  if (!hasPastCurrent) return false
  // Qualquer intenção explícita de destino/interesse isenta a guarda
  if (userExpressesInterest(text)) return false
  if (/\b(desejo|pretendo)\b/i.test(t)) return false
  return true
}

/**
 * Curso citado após verbo de destino/interesse (ex.: "… e quero Administração").
 * Evita confirmar o primeiro curso de uma lista de formação anterior.
 */
export function extractCursoAfterDestinationIntent(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const patterns = [
    /\b(?:quero|desejo|pretendo)\s+(?:fazer|cursar|estudar|continuar(?:\s+com)?|mudar\s+para)?\s*(?:o|a|um|uma)?\s*(?:curso\s+(?:de|em)\s+)?(.+)$/i,
    /\b(?:gostaria\s+de)\s+(?:fazer|cursar|estudar)?\s*(?:o|a|um|uma)?\s*(?:curso\s+(?:de|em)\s+)?(.+)$/i,
    /\b(?:gostei\s+(?:de|do|da))\s+(?:curso\s+(?:de|em)\s+)?(.+)$/i,
    /\b(?:vou\s+fazer|tenho\s+interesse\s+(?:em|no|na))\s+(?:curso\s+(?:de|em)\s+)?(.+)$/i,
  ]
  for (const rx of patterns) {
    const m = raw.match(rx)
    if (!m?.[1]) continue
    const area = extractCursoAreaFromText(m[1])
    if (area) return area
  }
  return ''
}

function userConfirmsShortReply(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t || t.length > 40) return false
  return /^\s*(sim|s|quero|pode|bora|vamos|ok|gostei|isso|esse\s+curso|fazer)\b/i.test(t)
}

/** Assistente listou opções de curso ou pediu escolha entre elas. */
export function assistantOfferedCourseOptions(historyMessages) {
  const content = lastAssistantText(historyMessages).toLowerCase()
  if (!content) return false
  return (
    /\b\d{1,2}[\.\)]\s+/.test(content) ||
    /\b(oferecemos|nessa\s+[aá]rea|desses\s+cursos|algum\s+desses|mais\s+detalhes)\b/i.test(content) ||
    (/\b(gest[aã]o|ci[eê]ncias|contab|marketing|administra)/i.test(content) &&
      /\b(quer\s+saber|mensalidade|valor|curso[s]?)\b/i.test(content))
  )
}

function lastAssistantMentionedCurso(historyMessages) {
  if (assistantOfferedCourseOptions(historyMessages)) return true
  const content = lastAssistantText(historyMessages).toLowerCase()
  if (!content) return false
  return (
    /\bcurso\s+de\s+/i.test(content) ||
    /\b(matricul|inscri|ingressar|vestibular)\b/i.test(content)
  )
}

/** Lead respondeu "1", "2"… após lista numerada do assistente. */
export function matchCursoFromNumberedAssistantList(userMessage, historyMessages) {
  const t = normalizeMessageForScope(userMessage).trim()
  const numMatch = t.match(/^\s*([1-9])\s*$/) || t.match(/^\s*op[cç][aã]o\s*([1-9])\s*$/i)
  if (!numMatch) return ''
  const idx = Number(numMatch[1]) - 1
  const assist = lastAssistantText(historyMessages)
  if (!assist) return ''
  // Lista de polos numerada ≠ lista de cursos (regressão Jean #23912)
  if (assistantTextLooksLikePoloList(assist)) return ''
  const courses = []
  // /m + ^ por linha: evita consumir \n e pular o próximo item (ex.: "2. Biomedicina")
  const re = /^\s*(\d{1,2})[\.\)]\s*[*_]*([^*\n(]+?)[*_]*(?:\s*\(|$)/gim
  let m
  while ((m = re.exec(assist)) !== null) {
    const name = sanitizeCursoName(m[2].trim())
    if (name) courses.push(name)
  }
  const picked = courses[idx] || ''
  if (picked && isPoloNameLike(picked)) return ''
  return picked
}

/**
 * Mensagem é só nome de curso ou escolha na lista — continuação do atendimento.
 */
export function messageIsBareCourseSelection(userMessage, historyMessages = []) {
  if (!userMessage) return false
  const t = normalizeMessageForScope(userMessage)
  if (!t || t.length > 80) return false
  if (matchCursoFromNumberedAssistantList(userMessage, historyMessages)) return true
  const area = extractCursoAreaFromText(t)
  if (!area) return false
  if (assistantOfferedCourseOptions(historyMessages)) return true
  if (/\b(area|área)\s+(financeira|sa[uú]de|tecnolog)/i.test(t)) return false
  const tokens = t.split(/\s+/).filter(Boolean)
  if (tokens.length <= 6) return true
  return userExpressesInterest(userMessage)
}

/**
 * Retorna o nome do curso confirmado pelo lead nesta mensagem (ou string vazia).
 *
 * Cobre:
 *  - "quero fazer Fisioterapia" / "gostei de Administração" (curso explícito no texto)
 *  - "quero esse curso", "sim", "gostei" — quando o último turno do assistente
 *    já discutia um curso identificável no histórico.
 */
export function detectCursoConfirmadoPeloLead(userMessage, historyMessages) {
  if (!userMessage) return ''
  let result = ''
  const fromList = matchCursoFromNumberedAssistantList(userMessage, historyMessages)
  if (fromList) {
    result = fromList
  } else if (isPastOrCurrentFormationWithoutDestination(userMessage)) {
    result = ''
  } else {
    // Preferir curso após verbo de destino (não o primeiro de uma lista de formações)
    const afterDest = extractCursoAfterDestinationIntent(userMessage)
    if (afterDest) {
      result = sanitizeCursoName(afterDest)
    } else {
      const direct = extractCursoFromText(userMessage)
      if (direct && userExpressesInterest(userMessage)) result = sanitizeCursoName(direct)
      else if (direct && lastAssistantMentionedCurso(historyMessages)) result = sanitizeCursoName(direct)
      else if (direct && messageIsBareCourseSelection(userMessage, historyMessages)) {
        result = sanitizeCursoName(direct)
      } else if (userExpressesInterest(userMessage) || userConfirmsShortReply(userMessage)) {
        const fromHist = extractDiscussedCourseFromHistory(historyMessages)
        if (fromHist) result = sanitizeCursoName(fromHist)
      }
    }
  }
  // Guarda: nome de polo nunca vira curso
  if (result && isPoloNameLike(result)) return ''
  return result
}

export const __test = {
  extractCursoFromText,
  userExpressesInterest,
  titleCase,
  sanitizeCursoName,
  isPastOrCurrentFormationWithoutDestination,
  extractCursoAfterDestinationIntent,
  isPoloNameLike,
}
