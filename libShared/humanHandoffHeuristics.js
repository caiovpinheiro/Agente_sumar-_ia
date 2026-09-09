/**
 * Saída do canal (substitui o salesbot 49777 no pedido de humano):
 * lead pede atendimento humano OU o agente não resolve a dúvida →
 *   1) agente pergunta se o lead realmente não quer seguir por este canal;
 *   2) lead confirma → agente envia links oficiais (atendimento + ouvidoria)
 *      e o lead é movido para a fila 143 do pipeline 13756724.
 */

import { normalizeMessageForScope } from './scopeHeuristics.js'

export const HANDOFF_STATUS_AGUARDANDO_CONFIRM_SAIDA = 'aguardando_confirm_saida_canal'
export const HANDOFF_STATUS_LINKS_ENVIADOS = 'saida_canal_concluida'

export const SUMARE_ATENDIMENTO_URL = 'https://sumare.edu.br/atendimento/'
export const SUMARE_OUVIDORIA_URL = 'https://sumare.edu.br/ouvidoria.html'

function firstNameBit(pushName) {
  const raw = String(pushName || '').trim()
  if (!raw || /^lead\s*#/i.test(raw)) return ''
  return `, ${raw.split(/\s+/)[0]}`
}

/** Passo 1 — pergunta canônica antes de encerrar o atendimento pelo canal. */
export function buildConfirmExitChannelReply(opts = {}) {
  return (
    `Entendi${firstNameBit(opts.pushName)}! Antes de te direcionar, me confirma uma coisa: ` +
    `você prefere mesmo *não seguir o atendimento por aqui*? ` +
    `Posso continuar te ajudando por este canal com informações de cursos, valores e inscrição. ` +
    `Se preferir tratar diretamente com a Faculdade Sumaré, é só me confirmar.`
  )
}

/** Passo 2 — links oficiais de atendimento e ouvidoria. */
export function buildExitChannelLinksReply(opts = {}) {
  return (
    `Sem problemas${firstNameBit(opts.pushName)}! Você pode resolver sua dúvida diretamente com a Faculdade Sumaré pelo canal oficial de atendimento:\n\n` +
    `*Atendimento Sumaré:* ${SUMARE_ATENDIMENTO_URL}\n\n` +
    `Se preferir, você também pode entrar em contato com a *Ouvidoria* (reclamações, sugestões e elogios):\n\n` +
    `*Ouvidoria Sumaré:* ${SUMARE_OUVIDORIA_URL}\n\n` +
    `Obrigado pelo contato e estamos à disposição!`
  )
}

/**
 * Redirecionamento canônico quando o agente NÃO consegue concluir algo por
 * este canal (falha técnica, cadastro não localizado, curso não confirmado
 * etc.). Substitui qualquer promessa de "consultor entrará em contato" —
 * o lead é orientado a falar direto com a Faculdade Sumaré pelo atendimento
 * oficial (ou ouvidoria), nunca uma promessa de retorno ativo por aqui.
 */
export function buildFacultyContactRedirectReply(opts = {}) {
  return (
    `Peço desculpas${firstNameBit(opts.pushName)}, não consegui concluir isso por aqui. ` +
    `Para seguir, fale diretamente com a Faculdade Sumaré pelo canal oficial de atendimento:\n\n` +
    `*Atendimento Sumaré:* ${SUMARE_ATENDIMENTO_URL}\n\n` +
    `Se preferir, também pode contar com a *Ouvidoria* (reclamações, sugestões e elogios):\n\n` +
    `*Ouvidoria Sumaré:* ${SUMARE_OUVIDORIA_URL}\n\n` +
    `Estamos à disposição!`
  )
}

/** True se o texto é (ou contém) o redirect canônico de falha — não misturar com sucesso. */
export function replyLooksLikeFacultyContactRedirect(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  return (
    /n[aã]o consegui concluir isso por aqui/i.test(t) ||
    (t.includes(SUMARE_ATENDIMENTO_URL) && /atendimento oficial|Ouvidoria Sumar/i.test(t))
  )
}

/** Reapresenta os links se o lead voltar a falar depois do encerramento. */
export function buildExitChannelAlreadyDoneReply(opts = {}) {
  return (
    `Olá${firstNameBit(opts.pushName)}! Seu atendimento por aqui foi encerrado conforme combinamos. ` +
    `Para falar diretamente com a Faculdade Sumaré, use o canal oficial: ${SUMARE_ATENDIMENTO_URL}\n` +
    `Ouvidoria: ${SUMARE_OUVIDORIA_URL}`
  )
}

/** Detecta no histórico que a última fala do assistente foi a pergunta canônica do passo 1. */
export function assistantAskedExitChannelConfirm(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return false
  return (
    /n[ãa]o seguir o atendimento por aqui/.test(t) ||
    (/prefere mesmo/.test(t) && /atendimento por (aqui|este canal)/.test(t)) ||
    (/continuar te ajudando por este canal/.test(t) && /me confirma/.test(t))
  )
}

/**
 * Lead CONFIRMA que não quer seguir o atendimento pelo canal
 * (resposta à pergunta canônica do passo 1).
 */
export function messageConfirmsChannelExit(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t) return false
  // Confirmações curtas e diretas.
  if (/^(sim|s|isso|exato|confirmo|pode ser|quero|prefiro|ok|correto|com certeza|certeza|claro|isso mesmo|pode encerrar|encerra|encerrar)\b[.!\s]*$/i.test(t)) {
    return true
  }
  if (/\b(n[ãa]o\s+quero|prefiro\s+n[ãa]o|n[ãa]o\s+desejo)\b[\s\S]{0,40}\b(seguir|continuar|atendimento|por\s+aqui|esse\s+canal|este\s+canal|canal)\b/i.test(t)) {
    return true
  }
  if (/\b(prefiro|quero)\b[\s\S]{0,45}\b(direto|diretamente|com\s+a\s+(faculdade|sumar[eé])|outro\s+canal|site)\b/i.test(t)) {
    return true
  }
  if (/\bquero\s+ser\s+(direcionad|encaminhad|redirecionad)/i.test(t)) return true
  if (/\b(prefiro|quero)\b[\s\S]{0,30}\b(direcionad|encaminhad|redirecionad)/i.test(t)) return true
  if (/\bpode\s+me\s+(direcionar|encaminhar|redirecionar)\b/i.test(t)) return true
  if (/\b(me\s+)?(direciona|encaminha|redireciona)\b/i.test(t) && /\b(quero|por\s+favor|pfv|pode)\b/i.test(t)) {
    return true
  }
  if (/\b(pode|podem)\s+(encerrar|finalizar|fechar)\b/i.test(t)) return true
  if (/\bencerrar?\s+(o\s+)?(atendimento|conversa|chat)\b/i.test(t)) return true
  if (/\bn[ãa]o\s+quero\s+mais\s+(falar|conversar|atendimento|continuar)\b/i.test(t)) return true
  return false
}

/**
 * Lead quer CONTINUAR o atendimento pelo canal (recusa a saída).
 */
export function messageDeclinesChannelExit(text) {
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t) return false
  if (/^(n[ãa]o|nao quero sair|continua|continuar|segue|seguir|vamos continuar|pode continuar|por aqui mesmo|aqui mesmo|fica)\b[.!\s]*$/i.test(t)) {
    return true
  }
  if (/\b(quero|prefiro|pode|vamos)\s+(continuar|seguir)\b[\s\S]{0,35}(por\s+aqui|aqui|nesse\s+canal|neste\s+canal|com\s+voc[eê])?/i.test(t)) {
    return true
  }
  if (/\b(continua|segue)\s+(o\s+)?(atendimento|por\s+aqui|comigo)\b/i.test(t)) return true
  if (/\bn[ãa]o\s+precisa\s+(encerrar|finalizar|encaminhar)\b/i.test(t)) return true
  return false
}

/**
 * Após saída de canal concluída: lead pede atendimento novo ou abre dúvida.
 * Usado para reabrir o fluxo em vez de repetir a resposta canônica de encerrado.
 */
export function messageRequestsNewAttendance(text) {
  const raw = String(text || '').trim()
  const t = normalizeMessageForScope(text).toLowerCase().trim()
  if (!t) return false

  if (
    /\b(novo\s+atendimento|quero\s+(um\s+)?atendimento|preciso\s+de\s+(um\s+)?atendimento)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (
    /\b(posso\s+tirar\s+uma\s+d[uú]vida|tenho\s+uma\s+d[uú]vida|me\s+ajuda|gostaria\s+de\s+informa[cç][oõ]es)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\bquero\s+saber(\s+mais)?\s+sobre\b/i.test(t)) return true

  // Pergunta / menção substantiva a curso, valor, matrícula, boleto ou pagamento.
  if (
    /\b(curso|valores?|pre[cç]o|mensalidade|matr[ií]cula|inscri[cç][aã]o|boleto|pagamento)\b/i.test(
      t,
    )
  ) {
    if (/\?/.test(raw)) return true
    if (
      /\b(quero|sobre|quanto|como|quando|qual|pode|preciso|fiz|paguei|pagar|saber|tirar)\b/i.test(t)
    ) {
      return true
    }
  }

  // Mensagem terminada em "?" com conteúdo substantivo (mais de 3 palavras).
  if (/\?\s*$/.test(raw)) {
    const words = t
      .replace(/[?!.,;:…]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
    if (words.length > 3) return true
  }

  return false
}
