/**
 * Heurísticas de transferência externa — cenário Lidi (#24016559) + Leidy (#23889).
 * node scripts/test-transferencia-heuristics.mjs
 */
import {
  extractTransferenciaContext,
  extractTransferenciaDestinoFromAssistant,
  messageRestatesSameCourseAsDestino,
  parseSemestreFromUserMessage,
  isValidTransferenciaCursoLabel,
  isAmbiguousMultiFormationList,
  tryHandleTransferenciaDadosPendentes,
  assistantAskedTransferenciaDadosPendentes,
} from '../server/inscricaoTransferenciaFlow.js'
import {
  detectCursoConfirmadoPeloLead,
  isPastOrCurrentFormationWithoutDestination,
} from '../libShared/cursoConfirmation.js'
import { resolveTransferenciaCursoCodigo } from '../server/sumareCaptacaoClient.js'

const lidiHistory = [
  { role: 'user', content: 'Gostaria me matricular no curso de pedagogia como faço? Boa noite' },
  {
    role: 'assistant',
    content:
      'Perfeito! Então, ficou assim:\n- Você irá ingressar no curso de "Pedagogia" com duração de 8 semestres',
  },
  {
    role: 'user',
    content:
      'E q eu já comecei a pedagogia em outra faculdade. E esqueci de avisá-lo Tranquei no quarto semestre',
  },
  {
    role: 'assistant',
    content:
      'Ótimo! Para dar início ao processo de aproveitamento e transferência do seu curso de Pedagogia, preciso que você me informe o curso e o último semestre.',
  },
  { role: 'user', content: 'Como falei parei no quarto semestre' },
  {
    role: 'assistant',
    content:
      'Obrigado por informar que você parou no quarto semestre. Preciso que me confirme o nome exato do curso que você cursava na outra faculdade.',
  },
  { role: 'user', content: 'Só a pedagogia mesmo' },
]

const ctx = extractTransferenciaContext(lidiHistory)
console.log('context', ctx)

const checks = [
  ['destino Pedagogia', ctx?.destino === 'Pedagogia'],
  ['origem Pedagogia', ctx?.origem === 'Pedagogia'],
  ['semestre 4', ctx?.semestre === '4'],
  ['origem válida', isValidTransferenciaCursoLabel(ctx?.origem)],
  ['não parseia matricula inicial', ctx?.origem !== 'de pedagogia como faço? Boa noite'],
  ['same course restate', messageRestatesSameCourseAsDestino('Só a pedagogia mesmo', 'Pedagogia')],
  ['semestre quarto', parseSemestreFromUserMessage('Como falei parei no quarto semestre') === '4'],
]

// --- Destino explícito após formação passada ---
const mixedMsg = 'Cursei Pedagogia e quero Administração'
const mixedConfirmado = detectCursoConfirmadoPeloLead(mixedMsg, [])
checks.push(
  [
    'mixed não é só formação passada',
    isPastOrCurrentFormationWithoutDestination(mixedMsg) === false,
  ],
  [
    'mixed confirma Administração (não Pedagogia)',
    /administra/i.test(mixedConfirmado) && !/pedagogia/i.test(mixedConfirmado),
  ],
)

// --- Regressão Leidy #23889 (texto real do assistente) ---
const leidyUserMsg =
  'Cursei pedagogia, letras e estou cursando educação física licenciatura'

const leidyAssistPedido =
  'Entendo sua dúvida sobre redução de tempo por já ter outras formações. Para analisar aproveitamento de disciplinas e possível redução na duração do curso de Educação Física Bacharelado, é necessário um processo específico de transferência ou aproveitamento de matérias.\n\nPosso ajudar você a iniciar esse processo. Você já cursou ou está cursando outra graduação? Se sim, me informe o nome do curso, o último semestre concluído e o curso que deseja fazer na Sumaré (que no seu caso é Educação Física Bacharelado). Assim, posso orientar os próximos passos. Quer seguir com isso?'

const leidyHistory = [
  { role: 'user', content: 'Quero só o bacharel' },
  {
    role: 'assistant',
    content: leidyAssistPedido,
  },
]

const leidyCtx = extractTransferenciaContext([
  ...leidyHistory,
  { role: 'user', content: leidyUserMsg },
])
console.log('leidy context', leidyCtx)

const destinoFromAssist = extractTransferenciaDestinoFromAssistant(leidyAssistPedido)
const confirmado = detectCursoConfirmadoPeloLead(leidyUserMsg, leidyHistory)

const leidyPending = await tryHandleTransferenciaDadosPendentes(
  {},
  {
    telefone: '5511999999999',
    userMessage: leidyUserMsg,
    historyMessages: leidyHistory,
    executionId: 'test-leidy',
    model: 'test',
    t0: Date.now(),
  },
)

const pendingReply = String(leidyPending?.result?.reply || '')
const pendingHandled = Boolean(leidyPending?.handled)

checks.push(
  [
    'leidy destino assistente Bacharelado',
    /educa[cç][aã]o\s+f[ií]sica\s+bacharelado/i.test(destinoFromAssist || ''),
  ],
  [
    'leidy contexto destino Bacharelado',
    /educa[cç][aã]o\s+f[ií]sica\s+bacharelado/i.test(leidyCtx?.destino || ''),
  ],
  ['leidy origem não inventada', !leidyCtx?.origem],
  ['leidy semestre ausente', !leidyCtx?.semestre],
  ['leidy multi formation ambígua', isAmbiguousMultiFormationList(leidyUserMsg)],
  ['leidy detectCurso não confirma', confirmado === ''],
  [
    'leidy destino ≠ licenciatura',
    !/licenciatura/i.test(leidyCtx?.destino || '') && confirmado === '',
  ],
  ['leidy pedido pendente reconhecido', assistantAskedTransferenciaDadosPendentes(leidyAssistPedido)],
  ['leidy pending handled', pendingHandled],
  [
    'leidy pending mantém Bacharelado',
    /bacharelado/i.test(pendingReply) && !/licenciatura/i.test(pendingReply),
  ],
  [
    'leidy pending pede origem/semestre',
    /origem/i.test(pendingReply) && /semestre/i.test(pendingReply),
  ],
  [
    'leidy pending sem preço/matrícula',
    !/pre[cç]o|mensalidade|formul[aá]rio|matricular/i.test(pendingReply) &&
      !/\bdura[cç][aã]o\b/i.test(pendingReply),
  ],
)

const ruteHist = [
  {
    role: 'assistant',
    content:
      'Perfeito! Então, ficou assim:\n- Você irá ingressar no curso de "Educação Infantil e Desenvolvimento da Linguagem" com duração de 6 meses',
  },
  { role: 'user', content: '📋 Resposta do formulário — Data de Nascimento 12/02/1985' },
  {
    role: 'assistant',
    content:
      '1. *Educação Física - Bacharelado*\n2. *Educação Física - Licenciatura*\n3. *Análise e Desenvolvimento de Sistemas*',
  },
  { role: 'user', content: '1' },
]
const ruteCtx = extractTransferenciaContext(ruteHist)
checks.push(
  ['rute sem transferência no contexto', ruteCtx == null],
  ['rute data ≠ semestre', parseSemestreFromUserMessage('12/02/1985') == null],
)

if (process.env.SUMARE_CAPTACAO_TOKEN) {
  const adsTrap = await resolveTransferenciaCursoCodigo(
    process.env,
    'Educação Infantil e Desenvolvimento da Linguagem',
  )
  checks.push([
    'rute pós não resolve para ADS_EAD',
    !adsTrap || String(adsTrap.codigo || '').toUpperCase() !== 'ADS_EAD',
  ])
}

let fail = 0
for (const [name, ok] of checks) {
  console.log(ok ? 'OK' : 'FAIL', name)
  if (!ok) fail++
}

if (process.env.SUMARE_CAPTACAO_TOKEN) {
  const ped = await resolveTransferenciaCursoCodigo(process.env, 'Pedagogia')
  console.log('resolve Pedagogia', ped)
  if (!ped?.codigo) {
    console.log('FAIL resolve Pedagogia')
    fail++
  } else {
    console.log('OK resolve Pedagogia', ped.codigo)
  }
}

process.exit(fail > 0 ? 1 : 0)
