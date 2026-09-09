/**
 * Assuntos acadêmicos pós-matrícula (trancamento, cancelamento, ex-aluno, etc.)
 * → direcionamento aos canais oficiais (Portal do Aluno / atendimento / ouvidoria).
 */

import {
  SUMARE_ATENDIMENTO_URL,
  SUMARE_OUVIDORIA_URL,
  messageConfirmsChannelExit,
  assistantAskedExitChannelConfirm,
} from './humanHandoffHeuristics.js'
import { messageRequestsHuman, messageStrongHumanEscalation } from './scopeHeuristics.js'
import { lastAssistantText } from './conversationContextHeuristics.js'

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/** Nova captação / inscrição comercial — não é assunto acadêmico institucional. */
function looksLikeCommercialEnrollment(t) {
  if (/\b(quero|gostaria|posso|como)\s+(me\s+)?(matricular|inscrever|fazer\s+(a\s+)?inscri)/i.test(t)) return true
  if (/\b(valor|pre[cç]o|mensalidade|bolsa|desconto)\b/i.test(t) && !/\b(atrasad|inadimpl|d[eé]bito)/i.test(t)) return true
  if (/\b(transfer[eê]ncia|aproveitamento\s+de\s+mat[eé]rias?|dispensa\s+de\s+(mat[eé]rias?|disciplinas?))\b/i.test(t)) return true
  // Histórico/comprovante/documentos NO CONTEXTO de transferência/aproveitamento/dispensa
  // são pedido de entrega de documentação de ingresso (comercial), não atendimento
  // acadêmico de aluno já matriculado. Ítrio #24133683: "não querem meu histórico,
  // comprovante de matrícula para a dispensa de disciplinas?".
  if (
    /\b(hist[oó]rico|comprovante|documentos?)\b/i.test(t) &&
    /\b(transfer[eê]ncia|aproveitamento|dispensa)\b/i.test(t)
  ) {
    return true
  }
  // "Já sou formado e queria saber o tempo/curso…" = interesse comercial (nova/2ª graduação),
  // não pedido de secretaria/ex-aluno. Clayton #24121727: falso positivo em "formado".
  if (
    /\b(j[aá]\s+sou\s+formado|sou\s+formado|segunda\s+gradua[cç][aã]o|2[aª]\s+gradua[cç][aã]o)\b/i.test(t) &&
    /\b(cursar|curso|tempo|dura[cç][aã]o|quero|queria|gostaria|saber|matricular|inscrever|estudar|gradua)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(tempo|dura[cç][aã]o|semestres?)\b/i.test(t) && /\b(cursar|curso|gradua|faculdade|estudar)\b/i.test(t)) {
    return true
  }
  if (/\b(queria|quero|gostaria)\s+saber\b/i.test(t) && /\b(curso|cursar|gradua|mensalidade|valor)\b/i.test(t)) {
    return true
  }
  return false
}

/**
 * Contato com setor financeiro/cobrança ou emissão/2ª via de boleto institucional.
 * Negativos de forma de pagamento comercial têm precedência (conservador).
 * NÃO usar prefixo `financ` — evita FIES/financiamento/financeiramente.
 */
function messageAsksFinanceiroInstitucional(t) {
  // Negativos primeiro: boleto como forma de pagamento em captação comercial
  if (/\b(aceita|aceitam)\s+(pagar\s+)?(no\s+|em\s+|por\s+)?boleto\b/i.test(t)) return false
  if (/\bpode\s+ser\s+(no\s+|em\s+|por\s+)?boleto\b/i.test(t)) return false
  if (/\bposso\s+pagar\s+(no\s+|em\s+|por\s+|via\s+)?boleto\b/i.test(t)) return false
  if (/\bboleto\s+ou\s+cart[aã]o\b|\bcart[aã]o\s+ou\s+boleto\b/i.test(t)) return false
  if (/\bformas?\s+de\s+pagamento\b/i.test(t)) return false

  const contactIntent = /\b(falar\s+com|contato|setor|departamento|atendimento|secretaria)\b/i.test(t)

  // Setor financeiro / cobrança
  if (/\bfinanceiro\b/i.test(t) && contactIntent) return true
  if (/\bcobran[cç]a\b/i.test(t) && contactIntent) return true

  // Emissão / envio / 2ª via / regularização de boleto já gerado
  if (/\bboleto\b/i.test(t)) {
    if (/\b(preciso|me\s+manda|manda(?:r)?|envie|enviar|emitir|emiss[aã]o)\b/i.test(t)) return true
    if (/\b(segunda\s+via|2[aª]\s+via)\b/i.test(t)) return true
    if (/\bn[aã]o\s+chegou\b|\bvencid|\batrasad/i.test(t)) return true
    if (/\bquero\s+pagar\s+(o\s+)?boleto\b/i.test(t)) return true
  }

  return false
}

/**
 * Alteração/troca/transferência de polo de matrícula ativa (pós-matrícula).
 * Não cobre escolha comercial de polo pré-inscrição nem "polo" isolado.
 * `t` já vem normalizado (sem acentos).
 */
function messageAsksAcademicPoloChange(t) {
  if (!t || t.length < 4) return false
  // Escolha comercial pré-formulário / inscrição — não é assunto acadêmico.
  // Radicais truncados usam \w* (boundary direita após o restante da palavra).
  if (
    /\b(para\s+minha\s+inscri\w*|antes\s+do\s+formul\w*|antes\s+de\s+preencher\s+o\s+formul\w*|quero\s+me\s+inscrever|escolher\s+o\s+polo)\b/i.test(
      t,
    )
  ) {
    return false
  }
  if (!/\bpolos?\b/i.test(t)) return false
  // Intenção de alteração/movimentação (radicais + flexões comuns pós-normalize)
  if (
    /\b(mudar|mudei|mudanca|mudando|trocar|troca|troquei|trocando|alterar|alteracao|alterando|transferir|transferencia|transferindo|migrar|migracao|migrando)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Problema de acesso ao AVA / plataforma do aluno (pós-matrícula).
 * Não cobre formulário de inscrição do WhatsApp.
 * `t` já vem normalizado (sem acentos).
 */
function messageAsksStudentPlatformAccessIssue(t) {
  if (!t || t.length < 8) return false
  // Formulário comercial do WhatsApp — não é AVA/portal do aluno.
  if (/\bformul\w*\b/i.test(t) && !/\b(ava|ambiente\s+virtual|portal\s+do\s+aluno)\b/i.test(t)) {
    return false
  }
  const platform =
    /\b(ava|ambiente\s+virtual|portal\s+do\s+aluno|moodle)\b/i.test(t) ||
    (/\bplataforma\b/i.test(t) &&
      /\b(entrar|acessar|travad|login|senha|email|curso|aluno|ead)\b/i.test(t))
  if (!platform) return false
  if (
    /\btravad|\bnao\s+consigo\s+(entrar|digitar|acessar|sair)\b|\bnao\s+abre\b|\bcampo\s+de\s+email\b|\bacessar\s+o\s+curso\b|\bmodificar\s+perfil\b|\bpreferencias\b|\bprimeiro\s+acesso\b|\blogin\b|\bsenha\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\b(problema|erro|acesso)\b/i.test(t)) return true
  return false
}

/** Padrões de assunto acadêmico na mensagem isolada. */
export function messageAsksAcademicAffairsSupportInText(text) {
  const t = normalize(text)
  if (!t || t.length < 4) return false
  // Comercial primeiro; exceção: "transferência de polo" não é transferência de curso
  if (looksLikeCommercialEnrollment(t) && !messageAsksAcademicPoloChange(t)) return false

  if (/\b(trancar|trancamento|trancar\s+(o\s+)?curso|trancar\s+(a\s+)?matr[ií]cula)\b/i.test(t)) return true
  if (/\b(cancelar|cancelamento)\s+(a\s+)?(matr[ií]cula|curso|inscri[cç][aã]o)\b/i.test(t)) return true
  if (/\b(cancelar|cancelamento)\b/i.test(t) && /\b(matricula|curso)\b/i.test(t)) return true
  // Ex-aluno institucional / conclusão de curso. NÃO usar "formado" isolado —
  // "já sou formado e quero cursar X" é captação (veja looksLikeCommercialEnrollment).
  if (/\b(ex[-\s]?aluno|j[aá]\s+(fui|era)\s+aluno)\b/i.test(t)) return true
  if (/\b(j[aá]\s+conclu[ií]|j[aá]\s+finalizei)\b/i.test(t) && !/\b(quero|queria|gostaria|cursar|curso)\b/i.test(t)) {
    return true
  }
  if (/\bformado\b/i.test(t) && !/\b(quero|queria|gostaria|cursar|curso|tempo|dura|saber|estudar)\b/i.test(t)) {
    return true
  }
  if (/\b(situa[cç][aã]o\s+acad[eê]mica|secretaria\s+acad[eê]mica|coordena[cç][aã]o\s+do\s+curso)\b/i.test(t)) return true
  if (/\b(hist[oó]rico\s+escolar|hist[oó]rico\s+de\s+notas|declara[cç][aã]o\s+de\s+matr[ií]cula)\b/i.test(t)) return true
  if (/\bsegunda\s+via\b/i.test(t) && /\b(documento|diploma|certificado|hist[oó]rico)\b/i.test(t)) return true
  if (/\b(cola[cç][aã]o\s+de\s+grau|jubilamento|abandono\s+de\s+curso)\b/i.test(t)) return true
  if (/\b(portal\s+do\s+aluno|acesso\s+ao\s+portal)\b/i.test(t) && /\b(problema|senha|acesso|solicitar|pedido)\b/i.test(t)) return true
  if (/\b(inadimpl|mensalidade[s]?\s+atrasad|d[eé]bito\s+em\s+aberto|negativad)/i.test(t)) return true
  if (/\b(reclama[cç][aã]o|protocolo)\b/i.test(t) && /\b(acad[eê]mica|matr[ií]cula|curso|faculdade)\b/i.test(t)) return true
  if (/\bemitir\s+(o\s+)?diploma\b/i.test(t) || /\b(retirada\s+do\s+diploma)\b/i.test(t)) return true
  if (/\bdiploma\b/i.test(t)) return true
  if (/\bsolicita[cç][aã]o\s+de\s+diploma\b/i.test(t)) return true
  if (messageAsksFinanceiroInstitucional(t)) return true
  if (messageAsksAcademicPoloChange(t)) return true
  if (messageAsksStudentPlatformAccessIssue(t)) return true

  return false
}

/**
 * Dias/horários de aulas presenciais do Semipresencial.
 * Não cobre "quando começam as aulas" (início do curso — comercial).
 * Não entra no redirect de Portal do Aluno: candidato em captação ainda não é aluno.
 */
export function messageAsksPresencialClassDays(text) {
  const t = normalize(text)
  if (!t || t.length < 8) return false
  if (looksLikeCommercialEnrollment(t) && !/\b(presencialmente|presenciais|presencial)\b/i.test(t)) {
    return false
  }
  const asksStart =
    /\bquando\s+(comec|inici)/i.test(t) ||
    /\baulas?\s+v[aã]o\s+comecar\b/i.test(t) ||
    /\bcomeco\s+das\s+aulas\b/i.test(t)
  const asksWhichDays =
    /\b(quais?\s+(os\s+)?dias?|que\s+dias?|dias?\s+da\s+semana|calendario|horarios?)\b/i.test(t) ||
    /\bcomparecer\b/i.test(t)
  if (asksStart && !asksWhichDays) return false

  const presencial = /\b(presencialmente|presenciais|presencial)\b/i.test(t)
  if (!presencial) return false
  if (/\bcomparecer\b/i.test(t)) return true
  if (asksWhichDays) return true
  if (/\b(encontros?|aulas?)\b/i.test(t) && /\b(dias?|semana|calendario|horario)\b/i.test(t)) {
    return true
  }
  return false
}

/** Links oficiais quando a grade de dias presenciais não está neste canal. */
export function buildPresencialClassDaysRedirectReply(opts = {}) {
  const name = firstName(opts.pushName)
  const ola = name ? `Olá, ${name}!` : 'Olá!'
  return (
    `${ola} Os encontros presenciais do Semipresencial acontecem na Central da Faculdade Sumaré ` +
    `em Pinheiros (Rua Alegrete, 89, Sumaré, São Paulo/SP). ` +
    `Os dias e horários exatos seguem o calendário acadêmico da instituição e não tenho essa grade detalhada por aqui.\n\n` +
    `Para confirmar os dias presenciais, fale direto com a Faculdade Sumaré pelos canais oficiais:\n\n` +
    `*Atendimento Sumaré:* ${SUMARE_ATENDIMENTO_URL}\n\n` +
    `*Ouvidoria Sumaré:* ${SUMARE_OUVIDORIA_URL}\n\n` +
    `Não há consultor neste canal — o atendimento humano é só por esses links.`
  )
}

function assistantOfferedConsultant(text) {
  const t = normalize(text)
  if (!t) return false
  if (/\bconsultor\b/i.test(t) && /\b(verifique|verificar|passar|passo|encaminh|quer que)\b/i.test(t)) {
    return true
  }
  return false
}

/** Pedido curto de consultor/atendente neste canal (não existe). */
export function messageAsksConsultantOnThisChannel(text) {
  const t = normalize(text)
  if (!t || t.length > 90) return false
  if (/^(consultor|atendente|humano)[.!\s]*$/i.test(t)) return true
  if (/\bquero\s+(falar\s+com\s+)?(um\s+)?(consultor|atendente|humano)\b/i.test(t)) return true
  if (
    /\b(pode|podem)\s+(me\s+)?(passar|encaminhar|transferir)\s+(para|pra|pro)\s+(um\s+)?(consultor|atendente)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/** Lead aceitou oferta de consultor do assistente (ex.: "Por gentileza"). */
export function messageConfirmsConsultantOffer(text, historyMessages = []) {
  if (!assistantOfferedConsultant(lastAssistantText(historyMessages))) return false
  const t = normalize(text)
  if (!t || t.length > 80) return false
  if (/^(por\s+gentileza|por\s+favor|pfv|sim|pode|quero|isso|ok)[.!\s]*$/i.test(t)) return true
  if (messageAsksConsultantOnThisChannel(text)) return true
  return false
}

/** Histórico recente menciona assunto acadêmico institucional (diploma, trancamento, etc.). */
export function historyHasAcademicAffairsTopic(historyMessages = [], limit = 12) {
  if (!Array.isArray(historyMessages)) return false
  return historyMessages
    .slice(-limit)
    .some((m) => messageAsksAcademicAffairsSupportInText(String(m?.content || '')))
}

/** Follow-up sobre consultor ligar após pedido acadêmico (ex.: "Ele vai ligar?"). */
function messageAsksConsultantCallFollowUp(text) {
  const t = normalize(text)
  if (!t || t.length < 4) return false
  if (/\b(vai|v[aã]o)\s+ligar\b/i.test(t)) return true
  if (/\bquando\s+(me\s+)?ligam\b/i.test(t)) return true
  if (/\b(meu\s+)?consultor\b/i.test(t) && /\b(ligar|ligar[aã]o|contato|telefon)\b/i.test(t)) return true
  return false
}

function recentUserMessages(historyMessages, limit = 8) {
  if (!Array.isArray(historyMessages)) return []
  return historyMessages
    .filter((m) => m?.role === 'user')
    .slice(-limit)
    .map((m) => String(m.content || ''))
}

/**
 * Lead pede suporte acadêmico institucional (trancamento, cancelamento de matrícula
 * já ativa, ex-aluno, documentos escolares, etc.) — ou follow-up após pedido recente.
 */
export function messageAsksAcademicAffairsSupport(text, historyMessages = []) {
  if (messageAsksAcademicAffairsSupportInText(text)) return true
  if (messageAsksConsultantCallFollowUp(text)) {
    const recent = [...recentUserMessages(historyMessages), text]
    if (recent.some((msg) => messageAsksAcademicAffairsSupportInText(msg))) return true
  }
  if (!historyHasAcademicAffairsTopic(historyMessages)) return false
  if (messageStrongHumanEscalation(text) || messageRequestsHuman(text)) return true
  if (
    messageConfirmsChannelExit(text) &&
    assistantAskedExitChannelConfirm(lastAssistantText(historyMessages))
  ) {
    return true
  }
  return false
}

function firstName(nome) {
  const raw = String(nome || '').trim()
  if (!raw) return ''
  const first = raw.split(/\s+/)[0]
  if (!first || /\d/.test(first) || first.length < 2) return ''
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

/** Telefone geral / unidade Pinheiros — único número institucional canônico. */
export const SUMARE_INSTITUTIONAL_PHONE = '(11) 3067-7999'

/** Assistant recentemente orientou canais acadêmicos oficiais (redirect). */
function looksLikeAcademicAffairsRedirect(text) {
  const t = normalize(text)
  if (!t || t.length < 40) return false
  if (/\batendimento\s+academico\b/i.test(t) && /\bportal\s+do\s+aluno\b/i.test(t)) return true
  if (/sumare\.edu\.br\/atendimento/i.test(t) && /ouvidoria/i.test(t)) return true
  return false
}

function recentAssistantGaveAcademicRedirect(historyMessages = [], limit = 12) {
  if (!Array.isArray(historyMessages)) return false
  return historyMessages
    .slice(-limit)
    .some((m) => {
      const role = String(m?.role || '').toLowerCase()
      if (role !== 'assistant' && role !== 'assistente') return false
      return looksLikeAcademicAffairsRedirect(m?.content)
    })
}

/** Atualização/correção do telefone do próprio lead — fora do domínio institucional. */
function messageUpdatesOwnContactPhone(t) {
  if (/\b(meu\s+telefone|meu\s+whatsapp|meu\s+contato)\b/i.test(t)) return true
  if (/\b(atualizar|corrigir|trocar|alterar|mudar)\b[\s\S]{0,30}\b(telefone|whatsapp|contato)\b/i.test(t)) {
    return true
  }
  if (/\b(telefone|whatsapp|contato)\b[\s\S]{0,30}\b(mudou|errado|desatualiz)\b/i.test(t)) return true
  if (/\b(cadastro|dados\s+pessoais|dados\s+cadastrais)\b/i.test(t) && /\b(telefone|whatsapp|contato)\b/i.test(t)) {
    return true
  }
  return false
}

/** Telefone/contato de polo, localização ou região — não é o telefone institucional. */
function messageAsksPoloOrRegionalPhone(t) {
  if (/\b(polo|unidade|campus|endere[cç]o|localiza|onde\s+fica|zona|regi[aã]o|bairro|pr[oó]xim)\b/i.test(t)) {
    return true
  }
  return false
}

/** Pedido explícito de número/telefone neste turno (não “vai ligar?” de consultor). */
function messageAsksPhoneContactIntent(t) {
  if (!t || t.length < 4) return false
  if (/\b(telefone|telefones)\b/i.test(t)) return true
  if (/\b(n[uú]mero|numeros)\b/i.test(t) && !/\b(matricula|inscri|protocolo|cpf|rg)\b/i.test(t)) return true
  if (/\b(me\s+passa|passa\s+(o|esse)|manda\s+o|envie\s+o)\b[\s\S]{0,20}\b(telefone|n[uú]mero|contato)\b/i.test(t)) {
    return true
  }
  if (/\b(para\s+ligar|ligar\s+para|ligar\s+no|ligar\s+na|ligar\s+pro|ligar\s+pra)\b/i.test(t)) return true
  return false
}

/** Instituição / secretaria acadêmica explícitas no mesmo turno. */
function hasExplicitInstitutionalAcademicPhoneContext(t) {
  if (/\b(faculdade\s+sumar[eé]|sumar[eé])\b/i.test(t)) return true
  if (/\b(secretaria\s+academica|atendimento\s+academico|contato\s+institucional|institucional)\b/i.test(t)) {
    return true
  }
  if (/\bacademic[ao]\b/i.test(t) && /\b(telefone|n[uú]mero|ligar|contato|secretaria)\b/i.test(t)) return true
  return false
}

/** Follow-up curto pedindo telefone após redirect acadêmico recente. */
function isShortInstitutionalPhoneFollowUp(t) {
  if (!t || t.length > 72) return false
  if (!messageAsksPhoneContactIntent(t)) return false
  if (messageUpdatesOwnContactPhone(t)) return false
  if (messageAsksPoloOrRegionalPhone(t)) return false
  if (messageRequestsHuman(t) || messageStrongHumanEscalation(t)) return false
  return true
}

/**
 * Lead pede explicitamente o telefone institucional/acadêmico da Faculdade Sumaré,
 * ou faz follow-up curto após redirect acadêmico recente (ex.: "Preciso de telefone").
 */
export function messageAsksInstitutionalAcademicPhone(text, historyMessages = []) {
  const t = normalize(text)
  if (!t || t.length < 4) return false
  if (messageUpdatesOwnContactPhone(t)) return false
  if (messageAsksPoloOrRegionalPhone(t)) return false
  if (messageRequestsHuman(t) || messageStrongHumanEscalation(t)) return false
  // WhatsApp de inscrição / comercial — não é contato acadêmico.
  if (/\bwhatsapp\b/i.test(t) && /\b(inscri|matricul|consultor)\b/i.test(t)) return false

  if (messageAsksPhoneContactIntent(t) && hasExplicitInstitutionalAcademicPhoneContext(t)) {
    return true
  }

  if (!isShortInstitutionalPhoneFollowUp(t)) return false
  if (recentAssistantGaveAcademicRedirect(historyMessages)) return true
  if (historyHasAcademicAffairsTopic(historyMessages)) return true
  return false
}

/** Resposta curta com o telefone geral / unidade Pinheiros. */
export function buildInstitutionalAcademicPhoneReply(opts = {}) {
  const name = firstName(opts.pushName)
  const ola = name ? `Olá, ${name}!` : 'Olá!'
  return (
    `${ola} Para contato acadêmico/institucional da Faculdade Sumaré, ` +
    `o telefone geral (unidade Pinheiros) é *${SUMARE_INSTITUTIONAL_PHONE}*.`
  )
}

/** Mensagem canônica de direcionamento acadêmico. */
export function buildAcademicAffairsRedirectReply(opts = {}) {
  const name = firstName(opts.pushName)
  const ola = name ? `Olá, ${name}! Tudo bem?` : 'Olá! Tudo bem?'

  return (
    `${ola}\n\n` +
    `Para solicitações de *atendimento acadêmico*, o direcionamento correto depende da sua situação:\n\n` +
    `✅ *Alunos com matrícula ativa:*\n` +
    `O atendimento deve ser solicitado diretamente pelo *Portal do Aluno*, no setor responsável.\n\n` +
    `✅ *Ex-alunos, dúvidas gerais, cancelamento ou trancamento de matrícula:*\n` +
    `O atendimento deve ser feito pelo canal oficial da instituição:\n` +
    `${SUMARE_ATENDIMENTO_URL}\n\n` +
    `✅ *Ouvidoria:*\n` +
    `Caso deseje registrar uma manifestação, sugestão, reclamação ou acompanhamento pela Ouvidoria, acesse:\n` +
    `${SUMARE_OUVIDORIA_URL}\n\n` +
    `Reforçamos que dúvidas de *ex-alunos*, *cancelamento* ou *trancamento de matrícula* devem ser tratadas exclusivamente por um dos canais oficiais acima.\n\n` +
    `Estamos à disposição para orientar sobre o canal correto de atendimento.`
  )
}
