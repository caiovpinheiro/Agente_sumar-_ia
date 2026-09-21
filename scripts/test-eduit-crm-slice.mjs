/**
 * Testes focados — fatia EduIT (cliente / adapter / gate / outbound).
 * npm run test:eduit-slice
 */

import {
  EDUIT_DEFAULT_STAGES,
  EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID,
  EDUIT_DEFAULT_FORMULARIO_TAG_ID,
  isEduitCuid,
  pickPreferredDeal,
  pickPreferredContact,
  pickPreferredConversation,
  extractMessageId,
  resolveEduitStages,
  resolveEduitFormularioAutomationId,
  resolveEduitFormularioTagId,
  eduitAgentStageIds,
  getDealById,
  contactPhoneDigits,
  listConversationMessages,
  normalizeEduitConversationMessage,
  parseEduitMessageAt,
  runEduitAutomation,
  addDealTag,
  logConversationNote,
} from '../server/eduitClient.js'
import {
  buildFormularioFlowCrmNote,
  resolveFormularioMetaFlowId,
  DEFAULT_META_FLOW_FORMULARIO_ID,
} from '../server/whatsappSender.js'
import {
  getCrmBackend,
  isEduitBackend,
  normalizeCrmLeadId,
  leadMatchesEduitAgentFunnel,
  dealToAgentLead,
  assertLeadInAgentFunnel,
  leadMatchesAgentFunnel,
  persistEduitIds,
  loadCrmRecentMessages,
  resolveCrmLeadId,
} from '../server/crmAdapter.js'
import {
  mergeHistoriesDedupe,
  trimHistoryTail,
  mergeCrmAndSupabaseHistories,
} from '../libShared/historyMerge.js'
import {
  extractCadastroFieldsFromInbound,
  extractCpfFromText,
  extractEmailFromText,
  extractDataNascFromText,
  isValidCpfDigits,
} from '../libShared/cadastroInboundExtract.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  leadMatchesAgentFunnel as kommoLeadMatches,
} from '../server/kommoAgentFunnelGate.js'

const stats = { passed: 0, failed: 0, total: 0 }

function expect(label, ok) {
  stats.total += 1
  if (ok) {
    stats.passed += 1
    console.log(`  ok ${label}`)
  } else {
    stats.failed += 1
    console.error(`  FAIL ${label}`)
  }
}

// --- defaults / cuid ---
expect('cuid atendimento default', isEduitCuid(EDUIT_DEFAULT_STAGES.atendimento))
expect('cuid inscricao default', isEduitCuid(EDUIT_DEFAULT_STAGES.inscricao))
expect('cuid entrada default', isEduitCuid(EDUIT_DEFAULT_STAGES.entrada))
expect('numero nao e cuid', !isEduitCuid('25'))
expect('vazio nao e cuid', !isEduitCuid(''))

// --- backend default kommo ---
expect('default backend kommo', getCrmBackend({}) === 'kommo')
expect('CRM_BACKEND=eduit', getCrmBackend({ CRM_BACKEND: 'eduit' }) === 'eduit')
expect('isEduitBackend false default', !isEduitBackend({}))
expect('isEduitBackend true', isEduitBackend({ CRM_BACKEND: 'eduit' }))

// --- normalizeCrmLeadId nunca Number() em CUID ---
const cuid = EDUIT_DEFAULT_STAGES.atendimento
const normEduit = normalizeCrmLeadId(cuid, { CRM_BACKEND: 'eduit' })
expect('normalize cuid eduit string', typeof normEduit === 'string' && normEduit === cuid)
expect(
  'normalize cuid sem Number NaN',
  Number(cuid) !== Number(normEduit) || Number.isNaN(Number(cuid)),
)
expect(
  'normalize kommo numerico',
  normalizeCrmLeadId('19884275', { CRM_BACKEND: 'kommo' }) === 19884275,
)
expect('normalize reject 0', normalizeCrmLeadId(0, { CRM_BACKEND: 'kommo' }) == null)
{
  const resolved = await resolveCrmLeadId(
    { CRM_BACKEND: 'eduit' },
    '5511944690752',
    '23841399',
  )
  expect(
    'resolveCrmLeadId ignora id Kommo no backend eduit',
    resolved == null || /^c[a-z0-9]{8,}$/i.test(String(resolved)),
  )
}

// --- pickPreferredDeal ---
const stages = resolveEduitStages({})
const deals = [
  {
    id: 'cmtolddeal000000000000001',
    stageId: stages.fechamento,
    updatedAt: '2026-01-01T00:00:00.000Z',
    number: 10,
  },
  {
    id: 'cmtatenddeal0000000000002',
    stageId: stages.atendimento,
    updatedAt: '2026-02-01T00:00:00.000Z',
    number: 20,
  },
  {
    id: 'cmtinscdeal00000000000003',
    stageId: stages.inscricao,
    updatedAt: '2026-03-01T00:00:00.000Z',
    number: 30,
  },
]
const pick = pickPreferredDeal(deals, {})
expect('prefer inscricao/atendimento mais recente', pick.deal?.id === 'cmtinscdeal00000000000003')
expect('pick reason preferred_stage', String(pick.reason || '').startsWith('preferred_stage:'))

const onlyOther = pickPreferredDeal(
  [{ id: 'cmtother00000000000000001', stageId: stages.fechamento, updatedAt: '2026-04-01T00:00:00Z', number: 1 }],
  {},
)
expect('fallback most recent', onlyOther.deal?.id === 'cmtother00000000000000001')

// --- gate EduIT ---
const agentStages = eduitAgentStageIds({})
expect('agent stages = 3', agentStages.length === 3)
expect('agent includes atendimento', agentStages.includes(stages.atendimento))
expect('agent includes inscricao', agentStages.includes(stages.inscricao))
expect('agent includes aguardando pagamento', agentStages.includes(stages.aguardandoPagamento))

const leadAtend = dealToAgentLead({ id: 'cmtleadatend0000000000001', stageId: stages.atendimento }, {})
expect('leadMatches atendimento', leadMatchesEduitAgentFunnel(leadAtend, {}))
expect(
  'leadMatches entrada false',
  !leadMatchesEduitAgentFunnel(
    dealToAgentLead({ id: 'cmtleadent000000000000001', stageId: stages.entrada }, {}),
    {},
  ),
)

// Adapter leadMatches com backend eduit
expect(
  'adapter leadMatches eduit',
  leadMatchesAgentFunnel(leadAtend, { env: { CRM_BACKEND: 'eduit' } }),
)

// Kommo path intacto via adapter default
expect(
  'adapter kommo leadMatches',
  leadMatchesAgentFunnel(
    { pipeline_id: AGENT_FUNNEL_PIPELINE_ID, status_id: 106140284 },
    { env: { CRM_BACKEND: 'kommo' } },
  ),
)
expect(
  'kommo gate direto intacto',
  kommoLeadMatches({ pipeline_id: 13756724, status_id: 106140284 }),
)

// getDealById rejeita número
{
  const r = await getDealById({ EDUIT_BASE_URL: 'https://example.invalid', EDUIT_API_KEY: 'x' }, '25')
  expect('getDealById rejeita numero', r.ok === false && r.code === 'DEAL_NUMBER_FORBIDDEN')
}

// assertLeadInAgentFunnel kommo skip
{
  const r = await assertLeadInAgentFunnel({ CRM_BACKEND: 'kommo' }, { skip: true })
  expect('assert skip kommo', r.ok === true)
}
{
  const r = await assertLeadInAgentFunnel({ CRM_BACKEND: 'eduit' }, { skip: true })
  expect('assert skip eduit', r.ok === true)
}

{
  const miss = await persistEduitIds({}, '5511999999999', {})
  expect('persistEduitIds MISSING_IDS', miss.ok === false && miss.code === 'MISSING_IDS')
}

// sendText / outbound path — mock fetch
{
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'cmtmsg000000000000000001' }),
    }
  }
  try {
    const { sendText } = await import('../server/whatsappSender.js')
    const env = {
      CRM_BACKEND: 'eduit',
      EDUIT_BASE_URL: 'https://eduit.test',
      EDUIT_API_KEY: 'test-key-not-real',
    }
    const out = await sendText(env, {
      to: '5511999999999',
      text: 'ola',
      conversationId: 'cmtconv00000000000000001',
    })
    expect('sendText eduit ok', out.ok === true && out.via === 'eduit')
    expect('sendText nao chama graph.facebook', !calls.some((c) => /graph\.facebook/.test(c.url)))
    expect(
      'sendText POST conversa',
      calls.some(
        (c) =>
          c.method === 'POST' &&
          /\/api\/conversations\/cmtconv00000000000000001\/messages/.test(c.url),
      ),
    )
    const body = JSON.parse(calls.find((c) => c.method === 'POST')?.body || '{}')
    expect('sendText body type text', body.type === 'text' && body.content === 'ola')
  } finally {
    globalThis.fetch = prevFetch
  }
}

// --- extractMessageId shapes ---
expect('extractMessageId {id}', extractMessageId({ id: 'cmtmsgid0000000000000001' }) === 'cmtmsgid0000000000000001')
expect(
  'extractMessageId {messageId}',
  extractMessageId({ messageId: 'cmtmsgid0000000000000002' }) === 'cmtmsgid0000000000000002',
)
expect(
  'extractMessageId {message:{id}}',
  extractMessageId({ message: { id: 'cmtmsgid0000000000000003' } }) === 'cmtmsgid0000000000000003',
)
expect('extractMessageId null', extractMessageId(null) == null)
expect('extractMessageId {}', extractMessageId({}) == null)

expect(
  'meta flow id default',
  resolveFormularioMetaFlowId({}) === DEFAULT_META_FLOW_FORMULARIO_ID,
)
expect(
  'meta flow id env',
  resolveFormularioMetaFlowId({ WHATSAPP_META_FLOW_FORMULARIO_ID: '123' }) === '123',
)
expect(
  'crm note tem flow e wamid',
  /Preencha o formulário: Candidato/.test(buildFormularioFlowCrmNote({ flowId: '1', messageId: 'wamid.x' })) &&
    /flow_id=1/.test(buildFormularioFlowCrmNote({ flowId: '1', messageId: 'wamid.x' })) &&
    /wamid=wamid.x/.test(buildFormularioFlowCrmNote({ flowId: '1', messageId: 'wamid.x' })),
)
expect(
  'nota privada some do hist agente',
  normalizeEduitConversationMessage({
    id: 'cmtnote000000000000000001',
    direction: 'out',
    messageType: 'note',
    isPrivate: true,
    content: 'Preencha o formulário: Candidato',
  }) == null,
)

const noteMissing = await logConversationNote({}, '', 'x')
expect('logConversationNote sem conv', noteMissing.ok === false && noteMissing.code === 'MISSING_CONVERSATION_ID')

// --- pickPreferredContact ---
{
  const contacts = [
    { id: 'cmtcontactwrong0000000001', phone: '5511888888888' },
    { id: 'cmtcontactexact0000000002', phone: '5511999999999' },
  ]
  const pick = pickPreferredContact(contacts, '5511999999999')
  expect('pick contact exact phone', pick.contact?.id === 'cmtcontactexact0000000002')
  expect('pick contact reason exact', pick.reason === 'exact_phone')
  const fb = pickPreferredContact([{ id: 'cmtcontactonly00000000001', phone: '11977777777' }], '5511999999999')
  expect('pick contact fallback first', fb.contact?.id === 'cmtcontactonly00000000001' && fb.reason === 'first_fallback')
}

// --- pickPreferredConversation ---
{
  const convs = [
    { id: 'cmtconvclosed000000000001', status: 'closed', updatedAt: '2026-08-20T00:00:00Z' },
    { id: 'cmtconvopenold00000000002', status: 'open', updatedAt: '2026-08-21T00:00:00Z' },
    { id: 'cmtconvopennew00000000003', status: 'active', updatedAt: '2026-08-25T00:00:00Z' },
  ]
  const pick = pickPreferredConversation(convs)
  expect('pick conv open most recent', pick.conversation?.id === 'cmtconvopennew00000000003')
  expect('pick conv reason open', String(pick.reason).startsWith('open_most_recent:'))

  const noHints = pickPreferredConversation([
    { id: 'cmtconva00000000000000001', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'cmtconvb00000000000000002', updatedAt: '2026-06-01T00:00:00Z' },
  ])
  expect('pick conv fallback most recent', noHints.conversation?.id === 'cmtconvb00000000000000002')
}

// sendMessageWithNote EduIT: só /messages — nunca /notes nem Graph/Evolution
{
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: { id: 'cmtmsgnested00000000001' } }),
    }
  }
  try {
    const { sendMessageWithNote } = await import('../server/whatsappSender.js')
    const env = {
      CRM_BACKEND: 'eduit',
      EDUIT_BASE_URL: 'https://eduit.test',
      EDUIT_API_KEY: 'test-key-not-real',
      WHATSAPP_PHONE_NUMBER_ID: 'should-not-use',
      WHATSAPP_ACCESS_TOKEN: 'should-not-use',
      WHATSAPP_OUTBOUND_MODE: 'cloud',
    }
    const out = await sendMessageWithNote(env, {
      telefone: '5511999999999',
      text: 'resposta eduit',
      leadId: 'cmtdeallead0000000000001',
      conversationId: 'cmtconvsend0000000000001',
      executionId: 'ex-test-1',
      freshUserTurn: true,
    })
    expect('sendMessageWithNote eduit ok', out.ok === true && (out.sent || 0) >= 1)
    expect(
      'sendMessageWithNote so /messages',
      calls.every(
        (c) =>
          c.method !== 'POST' ||
          /\/api\/conversations\/[^/]+\/messages/.test(c.url),
      ) && calls.some((c) => c.method === 'POST' && /\/messages/.test(c.url)),
    )
    expect(
      'sendMessageWithNote nunca /notes',
      !calls.some((c) => /\/notes/.test(c.url)),
    )
    expect(
      'sendMessageWithNote nunca Graph',
      !calls.some((c) => /graph\.facebook/.test(c.url)),
    )
    expect(
      'sendMessageWithNote nunca Evolution sendText',
      !calls.some((c) => /\/message\/sendText|evolution/i.test(c.url)),
    )
    const noteSteps = (out.steps || []).filter((s) => s.step === 'note')
    expect(
      'sendMessageWithNote note skipped eduit',
      noteSteps.length > 0 && noteSteps.every((s) => s.skipped === true && s.reason === 'eduit_conversation_only'),
    )
  } finally {
    globalThis.fetch = prevFetch
  }
}

// --- backfill batch index helpers ---
{
  const {
    stageIdsForBackfill,
    phoneVariants,
    extractContactIdFromDeal,
    extractPhonesFromDeal,
    buildDealPhoneIndex,
    lookupPreferredDealForPhone,
    dealNeedsDetailEnrichment,
    parseRetryAfterMs,
    isRateLimitResult,
  } = await import('./lib/backfillEduitIndex.mjs')
  const { withThrottleRetry } = await import('./backfill-eduit-ids.mjs')

  const stageIds = stageIdsForBackfill({
    pipelineId: 'cmtpipe000000000000000001',
    entrada: 'cmtstageent0000000000001',
    atendimento: 'cmtstageatend00000000002',
    inscricao: 'cmtstageinsc000000000003',
    atendimentoDup: 'cmtstageatend00000000002',
  })
  expect('stageIds exclude pipeline', !stageIds.includes('cmtpipe000000000000000001'))
  expect('stageIds dedupe', stageIds.filter((id) => id === 'cmtstageatend00000000002').length === 1)
  expect('stageIds has 3', stageIds.length === 3)

  expect('phoneVariants 55', phoneVariants('5511999999999').includes('11999999999'))
  expect(
    'extractContactId aliases',
    extractContactIdFromDeal({ contact: { id: 'cmtcontactaaa00000000001' } }) ===
      'cmtcontactaaa00000000001',
  )
  expect(
    'extractPhones from deal.contact',
    extractPhonesFromDeal({ contact: { phone: '5511888777666' } }).includes('5511888777666'),
  )
  expect(
    'dealNeedsDetail when no phone',
    dealNeedsDetailEnrichment({ id: 'cmtdealneed0000000000001', contactId: 'cmtc1' }, () => []),
  )

  const deals = [
    {
      id: 'cmtdealfech00000000000001',
      stageId: stages.fechamento,
      contactId: 'cmtcfech0000000000000001',
      contact: { phone: '5511999999999' },
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'cmtdealatend0000000000002',
      stageId: stages.atendimento,
      contactId: 'cmtcatend000000000000002',
      contact: { phone: '11999999999' },
      updatedAt: '2026-06-01T00:00:00Z',
    },
  ]
  const idx = buildDealPhoneIndex(deals, contactPhoneDigits)
  const looked = lookupPreferredDealForPhone(idx, '5511999999999', pickPreferredDeal, {})
  expect('batch index prefer atendimento', looked.deal?.id === 'cmtdealatend0000000000002')
  expect('batch index contactId', looked.contactId === 'cmtcatend000000000000002')
  expect('batch index dealsMatched', looked.dealsMatched === 2)

  expect('parseRetryAfter seconds', parseRetryAfterMs('2', 100) === 2000)
  expect('isRateLimit 429', isRateLimitResult({ status: 429 }))
  expect('isRateLimit text', isRateLimitResult({ error: 'Rate limit exceeded' }))

  let calls = 0
  const retried = await withThrottleRetry(
    async () => {
      calls += 1
      if (calls < 3) return { ok: false, status: 429, error: 'rate limit' }
      return { ok: true, status: 200 }
    },
    { delayMs: 0, maxRetries: 5, label: 'test' },
  )
  expect('withThrottleRetry recovers 429', retried.ok === true && calls === 3)
}

// --- listConversationMessages: filtros / ordem / at em ms ---
{
  expect(
    'parseEduitMessageAt ISO → ms',
    parseEduitMessageAt('2026-08-27T12:00:00.000Z') === Date.parse('2026-08-27T12:00:00.000Z'),
  )
  expect('parseEduitMessageAt epoch ms', parseEduitMessageAt(1_700_000_000_000) === 1_700_000_000_000)
  expect('parseEduitMessageAt epoch s', parseEduitMessageAt(1_700_000_000) === 1_700_000_000_000)

  expect(
    'normalize filtra private',
    normalizeEduitConversationMessage({
      id: 'cmtmsgpriv00000000000001',
      direction: 'in',
      content: 'segredo',
      isPrivate: true,
      createdAt: '2026-08-27T10:00:00Z',
    }) == null,
  )
  expect(
    'normalize filtra note',
    normalizeEduitConversationMessage({
      id: 'cmtmsgnote00000000000001',
      direction: 'out',
      type: 'note',
      content: 'nota interna',
      createdAt: '2026-08-27T10:00:00Z',
    }) == null,
  )
  expect(
    'normalize filtra sem role',
    normalizeEduitConversationMessage({
      id: 'cmtmsgnorole000000000001',
      content: 'texto',
      createdAt: '2026-08-27T10:00:00Z',
    }) == null,
  )
  expect(
    'normalize filtra content vazio',
    normalizeEduitConversationMessage({
      id: 'cmtmsgempty0000000000001',
      direction: 'in',
      content: '   ',
      createdAt: '2026-08-27T10:00:00Z',
    }) == null,
  )
  const normIn = normalizeEduitConversationMessage({
    id: 'cmtmsgin0000000000000001',
    direction: 'inbound',
    content: 'oi',
    createdAt: '2026-08-27T10:00:00.000Z',
    seq: 2,
  })
  expect('normalize inbound → user', normIn?.role === 'user' && normIn.source === 'eduit')
  expect(
    'normalize at é number ms',
    typeof normIn?.at === 'number' && normIn.at === Date.parse('2026-08-27T10:00:00.000Z'),
  )
  expect(
    'normalize outbound → assistant',
    normalizeEduitConversationMessage({
      id: 'cmtmsgout000000000000001',
      direction: 'out',
      content: 'olá',
      createdAt: '2026-08-27T10:01:00Z',
    })?.role === 'assistant',
  )

  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        messages: [
          {
            id: 'cmtmsgb00000000000000002',
            direction: 'out',
            content: 'segunda',
            createdAt: '2026-08-27T10:02:00.000Z',
            seq: 2,
          },
          {
            id: 'cmtmsga00000000000000001',
            direction: 'in',
            content: 'primeira',
            createdAt: '2026-08-27T10:01:00.000Z',
            seq: 1,
          },
          {
            id: 'cmtmsgnote00000000000003',
            direction: 'out',
            type: 'note',
            content: 'interna',
            createdAt: '2026-08-27T10:03:00.000Z',
          },
          {
            id: 'cmtmsgc00000000000000003',
            direction: 'in',
            content: 'terceira',
            createdAt: '2026-08-27T10:00:00.000Z',
            seq: 0,
          },
        ],
      }),
  })
  try {
    const listed = await listConversationMessages(
      { EDUIT_BASE_URL: 'https://eduit.test', EDUIT_API_KEY: 'k' },
      'cmtconvhist0000000000001',
      { limit: 30 },
    )
    expect('listConversationMessages ok', listed.ok === true)
    expect('listConversationMessages filtra note', listed.messages.length === 3)
    expect(
      'listConversationMessages ordem crescente',
      listed.messages.map((m) => m.content).join('|') === 'terceira|primeira|segunda',
    )
    expect(
      'listConversationMessages at number',
      listed.messages.every((m) => typeof m.at === 'number'),
    )
  } finally {
    globalThis.fetch = prevFetch
  }

  const badId = await listConversationMessages(
    { EDUIT_BASE_URL: 'https://eduit.test', EDUIT_API_KEY: 'k' },
    '25',
  )
  expect('listConversationMessages rejeita numero', badId.ok === false && badId.code === 'MISSING_CONVERSATION_ID')
}

// --- loadCrmRecentMessages ---
{
  const kommo = await loadCrmRecentMessages({ CRM_BACKEND: 'kommo' }, { telefone: '5511999999999' })
  expect('loadCrm kommo skip', kommo.ok === true && kommo.source === 'kommo_skip' && kommo.messages.length === 0)

  const prevFetch = globalThis.fetch
  const nowIso = new Date().toISOString()
  const oldIso = new Date(Date.now() - 100 * 3600 * 1000).toISOString()
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (/\/messages/.test(u)) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { id: 'cmtmsgold000000000000001', direction: 'in', content: 'velha', createdAt: oldIso },
            { id: 'cmtmsgnew000000000000001', direction: 'in', content: 'nova', createdAt: nowIso },
          ]),
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) }
  }
  try {
    const env = {
      CRM_BACKEND: 'eduit',
      EDUIT_BASE_URL: 'https://eduit.test',
      EDUIT_API_KEY: 'k',
      AGENT_EDUIT_HISTORY_MAX_AGE_HOURS: '72',
    }
    const loaded = await loadCrmRecentMessages(env, {
      telefone: '5511999999999',
      conversationId: 'cmtconvload0000000000001',
    })
    expect('loadCrm eduit ok', loaded.ok === true && loaded.source === 'eduit')
    expect('loadCrm conversationId string cuid', loaded.conversationId === 'cmtconvload0000000000001')
    expect('loadCrm filtra idade 72h', loaded.messages.length === 1 && loaded.messages[0].content === 'nova')
  } finally {
    globalThis.fetch = prevFetch
  }

  const missing = await loadCrmRecentMessages(
    { CRM_BACKEND: 'eduit', EDUIT_BASE_URL: 'https://eduit.test', EDUIT_API_KEY: 'k' },
    { telefone: '' },
  )
  expect(
    'loadCrm sem conversa nao lanca',
    missing.ok === true && missing.messages.length === 0 && missing.conversationId == null,
  )
}

// --- mergeCrmAndSupabaseHistories ---
{
  const n8n = [
    { role: 'user', content: 'oi n8n' },
    { role: 'assistant', content: 'ola n8n' },
  ]
  const chat = [
    { role: 'user', content: 'oi chat', at: Date.parse('2026-08-20T10:00:00Z') },
    { role: 'assistant', content: 'ola chat', at: Date.parse('2026-08-20T10:01:00Z') },
  ]
  const noCrm = mergeCrmAndSupabaseHistories({ crmMsgs: [], chatMsgs: chat, n8nMsgs: n8n })
  expect('merge sem CRM exclusive false', noCrm.exclusiveEduit === false)
  expect(
    'merge sem CRM = n8n+chat dedupe',
    noCrm.messages.map((m) => m.content).join('|') ===
      mergeHistoriesDedupe(n8n, chat).map((m) => m.content).join('|'),
  )

  const crmDense = [
    { role: 'user', content: 'u1', at: 1 },
    { role: 'assistant', content: 'a1', at: 2 },
    { role: 'user', content: 'u2', at: 3 },
    { role: 'assistant', content: 'a2', at: 4 },
  ]
  const exclusive = mergeCrmAndSupabaseHistories(
    { crmMsgs: crmDense, chatMsgs: chat, n8nMsgs: n8n },
    { minExclusiveTurns: 4, maxTail: 16 },
  )
  expect('merge CRM denso exclusiveEduit', exclusive.exclusiveEduit === true)
  expect(
    'merge CRM denso so CRM',
    exclusive.messages.length === 4 && exclusive.messages.every((m) => !String(m.content).includes('n8n')),
  )

  const crmThin = [
    { role: 'user', content: 'crm agora', at: Date.parse('2026-08-27T12:00:00Z') },
    { role: 'assistant', content: 'crm resp', at: Date.parse('2026-08-27T12:01:00Z') },
  ]
  const chatMixed = [
    { role: 'user', content: 'antes', at: Date.parse('2026-08-26T10:00:00Z') },
    { role: 'user', content: 'crm agora', at: Date.parse('2026-08-27T12:00:00Z') }, // dup CRM
    { role: 'user', content: 'depois chat', at: Date.parse('2026-08-27T13:00:00Z') },
  ]
  const n8nThin = [
    { role: 'assistant', content: 'n8n sem ts' },
    { role: 'user', content: 'crm agora' }, // perde pro CRM
  ]
  const thin = mergeCrmAndSupabaseHistories(
    { crmMsgs: crmThin, chatMsgs: chatMixed, n8nMsgs: n8nThin },
    { minExclusiveTurns: 4 },
  )
  expect('merge CRM thin exclusive false', thin.exclusiveEduit === false)
  const thinContents = thin.messages.map((m) => m.content)
  expect('merge thin mantem chat anterior', thinContents.includes('antes'))
  expect('merge thin drop chat posterior', !thinContents.includes('depois chat'))
  expect('merge thin dedupe CRM>chat', thinContents.filter((c) => c === 'crm agora').length === 1)
  expect('merge thin n8n sem ts inedito', thinContents.includes('n8n sem ts'))
  expect('merge thin CRM presente', thinContents.includes('crm resp'))
  expect('trimHistoryTail intacto', trimHistoryTail([1, 2, 3, 4], 2).length === 2)
}

// --- courseStateDrift (troca/stale vs snapshot CRM) ---
{
  const {
    normalizeCourseKey,
    detectCourseSwitchAgainstCrmState,
    extractCourseMention,
  } = await import('../libShared/courseStateDrift.js')

  expect(
    'normalize Pedagogia EAD == Semipresencial',
    normalizeCourseKey('Pedagogia EAD') === normalizeCourseKey('Pedagogia Semipresencial'),
  )
  expect(
    'normalize Psicopedagogia != Pedagogia',
    normalizeCourseKey('Psicopedagogia') !== normalizeCourseKey('Pedagogia'),
  )
  expect(
    'normalize Gestão de RH alias',
    normalizeCourseKey('Gestão de RH') === normalizeCourseKey('Recursos Humanos') ||
      normalizeCourseKey('Gestão de RH') === 'recursos humanos',
  )
  expect(
    'extract Gestão de RH',
    /gest[aã]o de rh|recursos humanos/i.test(extractCourseMention('Quero Gestão de RH')),
  )
  expect('extract Psicopedagogia', extractCourseMention('Psicopedagogia') === 'Psicopedagogia')
  expect('extract Biomedicina', extractCourseMention('curso de Biomedicina') === 'Biomedicina')
  expect('extract Pedagogia', extractCourseMention('Pedagogia licenciatura') === 'Pedagogia')

  // 1) snap Pedagogia + user+assistant Biomedicina + "Sim" => switched high
  {
    const r = detectCourseSwitchAgainstCrmState({
      snapshotCurso: 'Pedagogia',
      inscricaoStage: 'aguardando_aceite_contrato',
      userMessage: 'Sim',
      historyMessages: [
        { role: 'user', content: 'Me fala mais sobre o curso de biomedicina' },
        {
          role: 'assistant',
          content: 'O curso de Biomedicina na Sumaré é EAD. Deseja seguir com a inscrição?',
        },
      ],
    })
    expect('drift1 switched', r.switched === true)
    expect('drift1 not stale', r.staleUnknown === false)
    expect('drift1 confidence high', r.confidence === 'high')
    expect('drift1 previous Pedagogia', normalizeCourseKey(r.previous) === 'pedagogia')
    expect('drift1 current Biomedicina', normalizeCourseKey(r.current) === 'biomedicina')
    expect('drift1 stage', r.stageAtSwitch === 'aguardando_aceite_contrato')
  }

  // 2) snap Pedagogia + histórico só genérico/Sim => staleUnknown
  {
    const r = detectCourseSwitchAgainstCrmState({
      snapshotCurso: 'Pedagogia',
      inscricaoStage: 'aguardando_aceite_contrato',
      userMessage: 'Sim',
      historyMessages: [
        { role: 'assistant', content: 'Olá! Em que posso ajudar?' },
        { role: 'user', content: 'Ok' },
        { role: 'assistant', content: 'Deseja seguir com a inscrição?' },
      ],
    })
    expect('drift2 staleUnknown', r.staleUnknown === true)
    expect('drift2 not switched', r.switched === false)
    expect('drift2 current null', r.current == null)
    expect('drift2 previous Pedagogia', normalizeCourseKey(r.previous) === 'pedagogia')
  }

  // 3) snap ausente + Biomedicina => current, sem switch
  {
    const r = detectCourseSwitchAgainstCrmState({
      snapshotCurso: null,
      inscricaoStage: null,
      userMessage: 'Quero Biomedicina',
      historyMessages: [],
    })
    expect('drift3 not switched', r.switched === false)
    expect('drift3 not stale', r.staleUnknown === false)
    expect('drift3 current Biomedicina', normalizeCourseKey(r.current) === 'biomedicina')
    expect('drift3 confidence low', r.confidence === 'low')
  }

  // 4) snap Pedagogia EAD + histórico Pedagogia Semipresencial => sem switch
  {
    const r = detectCourseSwitchAgainstCrmState({
      snapshotCurso: 'Pedagogia EAD',
      inscricaoStage: 'aguardando_form_sumar',
      userMessage: 'quero seguir',
      historyMessages: [
        { role: 'user', content: 'Pedagogia Semipresencial' },
        {
          role: 'assistant',
          content: 'Perfeito, Pedagogia Semipresencial. Posso seguir com a matrícula?',
        },
      ],
    })
    expect('drift4 not switched', r.switched === false)
    expect('drift4 not stale', r.staleUnknown === false)
    expect('drift4 same key', normalizeCourseKey(r.previous) === normalizeCourseKey(r.current))
  }

  // 5) Psicopedagogia vs Pedagogia => switched (não substring)
  {
    const r = detectCourseSwitchAgainstCrmState({
      snapshotCurso: 'Pedagogia',
      inscricaoStage: 'aguardando_form_sumar',
      userMessage: 'Psicopedagogia',
      historyMessages: [
        { role: 'assistant', content: 'Temos pós em Psicopedagogia. Quer detalhes?' },
      ],
    })
    expect('drift5 switched', r.switched === true)
    expect('drift5 keys differ', normalizeCourseKey(r.previous) !== normalizeCourseKey(r.current))
    expect('drift5 current Psicopedagogia', normalizeCourseKey(r.current) === 'psicopedagogia')
  }

  // 6) histórico antigo Pedagogia + diálogo atual Biomedicina => current Biomedicina
  {
    const r = detectCourseSwitchAgainstCrmState({
      snapshotCurso: 'Pedagogia',
      inscricaoStage: 'aguardando_aceite_contrato',
      userMessage: 'Sim',
      historyMessages: [
        { role: 'user', content: 'Quero Pedagogia' },
        { role: 'assistant', content: 'Pedagogia EAD, mensalidade a partir de R$ 199.' },
        { role: 'user', content: 'Na verdade quero Biomedicina' },
        {
          role: 'assistant',
          content: 'Claro! Biomedicina é EAD. Deseja seguir com a inscrição?',
        },
      ],
    })
    expect('drift6 switched', r.switched === true)
    expect('drift6 current Biomedicina', normalizeCourseKey(r.current) === 'biomedicina')
    expect('drift6 confidence high', r.confidence === 'high')
  }
}

// --- agentRunner: flags histórico EduIT + drift guards (etapa 3) ---
{
  const {
    resolveEduitHistoryMode,
    isPhoneInEduitHistoryCanary,
    shouldFetchEduitCrmHistory,
    isEduitCourseDriftEnabled,
    shouldBlockStaleEnrollmentActions,
    shouldSkipRegressiveSumCurso,
    buildCourseDriftSystemHints,
    summarizeCourseSwitchForSnapshot,
  } = await import('../server/ai/agentRunner.js')
  const { detectCourseSwitchAgainstCrmState, normalizeCourseKey } = await import(
    '../libShared/courseStateDrift.js'
  )

  // Kommo: zero EduIT
  const kommoMode = resolveEduitHistoryMode({ CRM_BACKEND: 'kommo', AGENT_EDUIT_HISTORY_ENABLED: 'true' }, '5511999999999')
  expect('kommo history mode loadCrm false', kommoMode.loadCrm === false)
  expect('kommo history mode injectCrm false', kommoMode.injectCrm === false)
  expect('kommo drift disabled', isEduitCourseDriftEnabled({ CRM_BACKEND: 'kommo' }) === false)

  // Defaults EduIT: history off, drift on
  expect(
    'eduit history default off',
    resolveEduitHistoryMode({ CRM_BACKEND: 'eduit' }, '5511999999999').loadCrm === false,
  )
  expect('eduit drift default on', isEduitCourseDriftEnabled({ CRM_BACKEND: 'eduit' }) === true)
  expect(
    'eduit drift kill switch',
    isEduitCourseDriftEnabled({ CRM_BACKEND: 'eduit', AGENT_EDUIT_COURSE_DRIFT_ENABLED: 'false' }) === false,
  )

  // Canary
  expect('canary vazio = global', isPhoneInEduitHistoryCanary({ AGENT_EDUIT_HISTORY_CANARY_PHONES: '' }, '5511888777666'))
  expect(
    'canary match',
    isPhoneInEduitHistoryCanary({ AGENT_EDUIT_HISTORY_CANARY_PHONES: '5511999,888777666' }, '5511888777666'),
  )
  expect(
    'canary miss',
    !isPhoneInEduitHistoryCanary({ AGENT_EDUIT_HISTORY_CANARY_PHONES: '55119990000' }, '5511888777666'),
  )
  const canaryMissMode = resolveEduitHistoryMode(
    {
      CRM_BACKEND: 'eduit',
      AGENT_EDUIT_HISTORY_ENABLED: 'true',
      AGENT_EDUIT_HISTORY_CANARY_PHONES: '5511000000000',
    },
    '5511888777666',
  )
  expect('canary miss nao carrega', canaryMissMode.loadCrm === false)

  // Shadow: carrega mas não injeta
  const shadowMode = resolveEduitHistoryMode(
    {
      CRM_BACKEND: 'eduit',
      AGENT_EDUIT_HISTORY_ENABLED: 'true',
      AGENT_EDUIT_HISTORY_SHADOW: 'true',
    },
    '5511999999999',
  )
  expect('shadow loadCrm', shadowMode.loadCrm === true)
  expect('shadow nao injeta', shadowMode.injectCrm === false)
  expect('shadow flag', shadowMode.shadow === true)

  const injectMode = resolveEduitHistoryMode(
    { CRM_BACKEND: 'eduit', AGENT_EDUIT_HISTORY_ENABLED: 'true' },
    '5511999999999',
  )
  expect('enabled injeta', injectMode.injectCrm === true)

  // Pause: não busca CRM
  expect(
    'pause hold bloqueia CRM',
    shouldFetchEduitCrmHistory({ pauseHold: true, mode: injectMode }) === false,
  )
  expect(
    'sem pause permite CRM',
    shouldFetchEduitCrmHistory({ pauseHold: false, mode: injectMode }) === true,
  )

  // Tier exclusive (já coberto em merge) + William replay ponta a ponta lógica
  const williamCrm = [
    { role: 'user', content: 'Quero algo na área da saúde', at: 1000 },
    { role: 'assistant', content: 'Temos Biomedicina EAD. Quer detalhes?', at: 1001 },
    { role: 'user', content: 'Sim, me fala mais de Biomedicina', at: 1002 },
    { role: 'assistant', content: 'Biomedicina: duração e mensalidade. Deseja seguir com a inscrição?', at: 1003 },
    { role: 'user', content: 'Sim', at: 1004 },
  ]
  const williamChat = [
    { role: 'user', content: 'Quero Pedagogia', at: 100 },
    { role: 'assistant', content: 'Pedagogia no polo Tatuapé. Formulário enviado; aguardando aceite.', at: 101 },
  ]
  const williamMerged = mergeCrmAndSupabaseHistories(
    { crmMsgs: williamCrm, chatMsgs: williamChat, n8nMsgs: [] },
    { minExclusiveTurns: 4, maxTail: 20 },
  )
  expect('william exclusive EduIT', williamMerged.exclusiveEduit === true)
  expect(
    'william prioriza Biomedicina nao Pedagogia no hist',
    williamMerged.messages.some((m) => /biomedicina/i.test(m.content)) &&
      !williamMerged.messages.some((m) => /pedagogia/i.test(m.content)),
  )

  const williamDrift = detectCourseSwitchAgainstCrmState({
    historyMessages: williamMerged.messages.slice(0, -1), // sem o Sim final (vai em userMessage)
    snapshotCurso: 'Pedagogia',
    inscricaoStage: 'aguardando_aceite_contrato',
    userMessage: 'Sim',
  })
  expect('william switched', williamDrift.switched === true)
  expect('william current Biomedicina', normalizeCourseKey(williamDrift.current) === 'biomedicina')
  expect('william block stale', shouldBlockStaleEnrollmentActions(williamDrift) === true)
  expect(
    'william skip sum_curso regressivo Pedagogia',
    shouldSkipRegressiveSumCurso(williamDrift, 'Pedagogia') === true,
  )
  expect(
    'william permite sum_curso Biomedicina',
    shouldSkipRegressiveSumCurso(williamDrift, 'Biomedicina') === false,
  )

  const williamHints = buildCourseDriftSystemHints(williamDrift)
  expect('william suppress form hints', williamHints.suppressStaleFormHints === true)
  expect(
    'william drift hint obsoleto',
    /OBSOLET|obsolet/i.test(williamHints.driftHint?.content || ''),
  )
  expect(
    'william drift hint nao afirma form enviado como verdade',
    /PROIBIDO afirmar que formulário/i.test(williamHints.driftHint?.content || ''),
  )
  expect(
    'william drift pede confirmacao/esclarecimento',
    /confirmação explícita|esclareça/i.test(williamHints.driftHint?.content || ''),
  )

  const snap = summarizeCourseSwitchForSnapshot(williamDrift)
  expect('snapshot courseSwitch switched', snap?.switched === true)
  expect('snapshot previousKey pedagogia', snap?.previousKey === 'pedagogia')
  expect('snapshot currentKey biomedicina', snap?.currentKey === 'biomedicina')

  const staleHints = buildCourseDriftSystemHints({
    switched: false,
    staleUnknown: true,
    previous: 'Pedagogia',
    current: null,
    confidence: 'medium',
  })
  expect('stale suppress hints', staleHints.suppressStaleFormHints === true)
  expect('stale pede clarificacao', /clarifica/i.test(staleHints.driftHint?.content || ''))
}

{
  expect(
    'form automation default id',
    resolveEduitFormularioAutomationId({}) === EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID,
  )
  expect(
    'form automation env override',
    resolveEduitFormularioAutomationId({
      EDUIT_AUTOMATION_FORMULARIO_SUM_ID: 'cmtbpgc9909ato701am40ffww',
    }) === 'cmtbpgc9909ato701am40ffww',
  )
  expect(
    'form automation ignora override invalido',
    resolveEduitFormularioAutomationId({ EDUIT_AUTOMATION_FORMULARIO_SUM_ID: '25' }) ===
      EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID,
  )

  const missingDeal = await runEduitAutomation(
    { EDUIT_BASE_URL: 'https://example.invalid', EDUIT_API_KEY: 'x' },
    EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID,
    { dealId: '25' },
  )
  expect('run automation rejeita deal numerico', missingDeal.code === 'MISSING_DEAL_ID')

  const missingAuto = await runEduitAutomation(
    { EDUIT_BASE_URL: 'https://example.invalid', EDUIT_API_KEY: 'x' },
    '25',
    { dealId: EDUIT_DEFAULT_STAGES.atendimento },
  )
  expect('run automation rejeita automation numerica', missingAuto.code === 'MISSING_AUTOMATION_ID')

  const origFetch = globalThis.fetch
  let captured = null
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), method: opts?.method, body: opts?.body }
    return new Response(JSON.stringify({ id: 'run_ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const okRun = await runEduitAutomation(
      { EDUIT_BASE_URL: 'https://crm.example', EDUIT_API_KEY: 'token' },
      EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID,
      { dealId: 'cmt4gmynp08xrlw01flba25la' },
    )
    expect('run automation ok mock', okRun.ok === true && okRun.runId === 'run_ok')
    expect(
      'run automation path',
      captured?.url ===
        `https://crm.example/api/automations/${EDUIT_DEFAULT_FORMULARIO_AUTOMATION_ID}/run`,
    )
    expect('run automation method post', captured?.method === 'POST')
    expect(
      'run automation body dealId',
      JSON.parse(captured?.body || '{}').dealId === 'cmt4gmynp08xrlw01flba25la',
    )
  } finally {
    globalThis.fetch = origFetch
  }
}

{
  expect(
    'form tag default id',
    resolveEduitFormularioTagId({}) === EDUIT_DEFAULT_FORMULARIO_TAG_ID,
  )
  expect(
    'form tag env override',
    resolveEduitFormularioTagId({ EDUIT_TAG_FORMULARIO_ID: EDUIT_DEFAULT_FORMULARIO_TAG_ID }) ===
      EDUIT_DEFAULT_FORMULARIO_TAG_ID,
  )
  expect(
    'form tag ignora override invalido',
    resolveEduitFormularioTagId({ EDUIT_TAG_FORMULARIO_ID: 'Formulario' }) ===
      EDUIT_DEFAULT_FORMULARIO_TAG_ID,
  )
  const missingTagDeal = await addDealTag(
    { EDUIT_BASE_URL: 'https://example.invalid', EDUIT_API_KEY: 'x' },
    '25',
    EDUIT_DEFAULT_FORMULARIO_TAG_ID,
  )
  expect('add tag rejeita deal numerico', missingTagDeal.code === 'MISSING_DEAL_ID')
  const missingTag = await addDealTag(
    { EDUIT_BASE_URL: 'https://example.invalid', EDUIT_API_KEY: 'x' },
    'cmt4gmynp08xrlw01flba25la',
    'Formulario',
  )
  expect('add tag rejeita tag invalida', missingTag.code === 'MISSING_TAG_ID')

  const origFetch = globalThis.fetch
  let captured = null
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), method: opts?.method, body: opts?.body }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const tagged = await addDealTag(
      { EDUIT_BASE_URL: 'https://crm.example', EDUIT_API_KEY: 'token' },
      'cmt4gmynp08xrlw01flba25la',
      EDUIT_DEFAULT_FORMULARIO_TAG_ID,
    )
    expect('add tag ok mock', tagged.ok === true)
    expect(
      'add tag path',
      captured?.url === 'https://crm.example/api/deals/cmt4gmynp08xrlw01flba25la/tags',
    )
    expect('add tag method post', captured?.method === 'POST')
    expect(
      'add tag body tagId',
      JSON.parse(captured?.body || '{}').tagId === EDUIT_DEFAULT_FORMULARIO_TAG_ID,
    )
  } finally {
    globalThis.fetch = origFetch
  }
}

{
  const {
    EDUIT_DEFAULT_PROBLEMA_MAT_TAG_ID,
    EDUIT_DEFAULT_PROBLEMA_MAT_AUTOMATION_ID,
    isMatriculaProblemaHoldEnabled,
    resolveEduitProblemaMatTagId,
    resolveEduitProblemaMatAutomationId,
  } = await import('../server/eduitClient.js')
  const {
    INSCRICAO_FORM_STATUS_PROBLEMA_MAT,
    shouldBlockFormularioSumResend,
    matriculaPosFormAlreadyProcessed,
  } = await import('../libShared/inscricaoFormHeuristics.js')
  expect(
    'problema_mat tag default',
    resolveEduitProblemaMatTagId({}) === EDUIT_DEFAULT_PROBLEMA_MAT_TAG_ID,
  )
  expect(
    'problema_mat automation default',
    resolveEduitProblemaMatAutomationId({}) === EDUIT_DEFAULT_PROBLEMA_MAT_AUTOMATION_ID,
  )
  expect('hold ligado por padrao', isMatriculaProblemaHoldEnabled({}) === true)
  expect(
    'hold desliga com false',
    isMatriculaProblemaHoldEnabled({ MATRICULA_PROBLEMA_HOLD: 'false' }) === false,
  )
  expect(
    'status problema_mat_hold bloqueia reenvio do form',
    shouldBlockFormularioSumResend({ inscricao_form_status: INSCRICAO_FORM_STATUS_PROBLEMA_MAT }) ===
      true,
  )
  expect(
    'hold e terminal pos-form',
    matriculaPosFormAlreadyProcessed({ inscricao_form_status: INSCRICAO_FORM_STATUS_PROBLEMA_MAT }) ===
      true,
  )
}

{
  expect('cpf checksum rejeita repetido', isValidCpfDigits('11111111111') === false)
  expect(
    'cpf extraido com rotulo',
    extractCpfFromText('CPF 36880225802') === '36880225802' ||
      extractCpfFromText('CPF 368.802.258-02').length === 11,
  )
  expect(
    'telefone 11 digitos nao vira cpf',
    extractCpfFromText('meu whats 11921216686', { phoneDigits: '5511921216686' }) === '',
  )
  expect(
    'email inbound',
    extractEmailFromText('leidy.santana19@hotmail.com') === 'leidy.santana19@hotmail.com',
  )
  expect('nasc br', extractDataNascFromText('19/06/1987') === '1987-06-19')
  const leidy = extractCadastroFieldsFromInbound('Sim', [
    { role: 'assistant', content: 'faltam informações no cadastro: cpf, email, dataNasc' },
    { role: 'user', content: 'CPF 36880225802' },
    { role: 'user', content: 'leidy.santana19@hotmail.com' },
    { role: 'user', content: '19/06/1987' },
  ], { phoneDigits: '5511921216686' })
  expect('leidy email', leidy.email === 'leidy.santana19@hotmail.com')
  expect('leidy nasc', leidy.dataNasc === '1987-06-19')
  expect('leidy cpf 11', leidy.cpf === '36880225802' || isValidCpfDigits(leidy.cpf))
  const flowEliane = extractCadastroFieldsFromInbound(
    'FORMULÁRIO flow 6 campos\nNome: Eliane Ferreira Maia\nCPF: 09189590805\nEmail: limaia36@gmail.com\nData de Nascimento: 13/12/1969',
    [],
  )
  expect('flow eliane email', flowEliane.email === 'limaia36@gmail.com')
  expect('flow eliane cpf', flowEliane.cpf === '09189590805')
  expect('flow eliane nome', flowEliane.nome === 'Eliane Ferreira Maia')
}

{
  const { looksLikeMatriculaPagamentoUrl, rowHasPagamentoLinkEnviado } = await import(
    '../libShared/matriculaPagamentoLink.js'
  )
  expect(
    'pagamento url portal',
    looksLikeMatriculaPagamentoUrl(
      'https://matricula.sumare.edu.br/Vestibular/pagamento?cpf=09189590805',
    ),
  )
  expect('pagamento url lixo', !looksLikeMatriculaPagamentoUrl('oi tudo bem'))
  expect(
    'row link enviado',
    rowHasPagamentoLinkEnviado({
      captacao_contrato_link: 'https://matricula.sumare.edu.br/Vestibular/pagamento?cpf=1',
    }),
  )
  expect(
    'row sem link',
    !rowHasPagamentoLinkEnviado({ captacao_candidato_id: 'abc' }),
  )
}

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
