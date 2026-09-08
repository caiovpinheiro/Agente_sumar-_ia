/**
 * Schemas das tools (OpenAI function-calling) — espelha src/lib/supabaseSearch.js.
 * Mantenha em sincronia com o front ao alterar argumentos/descrições.
 */

import { isInscricaoAutomaticaEnabled } from '../inscricaoConfig.js'

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'buscar_conhecimento',
      description:
        'Busca unificada na base vetorial da Faculdade Sumaré (graduação e pós-graduação: informações gerais e preços). ' +
        'Use como PRIMEIRA opção para dúvidas sobre curso, mensalidade, modalidade, grade, MBA, especialização, etc. ' +
        'O sistema escolhe automaticamente as tabelas corretas (pos_info, pos_preco, grad_info, grad_preco).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pergunta ou termos de busca (ex.: nome do curso + o que o lead quer saber).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_precos',
      description:
        'Busca preços e valores na base vetorial da Faculdade Sumaré (tabelas pos_preco / grad_preco via RPC). ' +
        'Alternativa a buscar_conhecimento quando o foco for só mensalidade/valor.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso (ex: "Administração").' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_informacoes',
      description:
        'Busca informações de GRADUAÇÃO na base vetorial da Faculdade Sumaré (grad_info). Prefira buscar_conhecimento se não tiver certeza do nível.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso de graduação.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_pos',
      description:
        'Busca informações de PÓS-GRADUAÇÃO na base da Faculdade Sumaré (pos_info). Prefira buscar_conhecimento se o nível não estiver claro.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome limpo do curso de pós-graduação.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_perguntas',
      description:
        'Busca respostas para perguntas frequentes (FAQ): matrícula, documentos, funcionamento, bolsas, processos, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pergunta do usuário.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inscricao',
      description:
        'Inscrição automática no Kommo (só quando INSCRICAO_AUTOMATICA_ENABLED=true). Na fase atual NÃO USE — confirme o curso e dispare o fluxo Form Sumar (regra 7). Não peça ENEM/Vestibular ao lead.',
      parameters: {
        type: 'object',
        properties: {
          curso: {
            type: 'string',
            description: 'Nome completo do curso confirmado pelo lead (ex.: "Desenvolvimento Backend").',
          },
          tipo_ingresso: {
            type: 'string',
            description: 'OPCIONAL — não pergunte ao lead. Se omitido, o servidor usa valor padrão (Vestibular).',
          },
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
          id_lead: {
            type: 'integer',
            description: 'OPCIONAL — id_lead do Kommo se já estiver no Contexto. OMITA se não souber.',
          },
        },
        required: ['curso', 'telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_historico_conversa',
      description:
        'Recupera histórico recente de conversa com o lead no WhatsApp (n8n_chat_histories). ' +
        'Use apenas se precisar de mais contexto além das últimas mensagens já injetadas.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_form_sumar_inscricao',
      description:
        'Envia o formulário de inscrição (Form Sumar) pelo WhatsApp via salesbot Kommo. ' +
        'CHAME quando o lead confirmar explicitamente que quer se inscrever em um curso específico ' +
        '(ex.: "quero me inscrever em administração", "quero seguir com a matrícula"). ' +
        'NÃO chame se o lead só pediu informações sobre cursos ou valores. ' +
        'Se o polo ainda não foi escolhido, o servidor pede polo antes de enviar — passe polo_id apenas se o lead já tiver citado o polo nesta conversa.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
          curso: { type: 'string', description: 'Curso confirmado pelo lead.' },
          polo_id: {
            type: 'string',
            enum: ['sao_miguel', 'barra_funda', 'tatuape', 'santana', 'pinheiros'],
            description: 'OPCIONAL — só informe se o lead já citou o polo nessa conversa.',
          },
        },
        required: ['telefone', 'curso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_polo_inscricao',
      description:
        'Registra o polo escolhido pelo lead (após você ter pedido escolha entre os 5 polos EAD) e dispara o Form Sumar em seguida. ' +
        'CHAME quando o lead responder com número (1-5) ou nome do polo (São Miguel, Barra Funda, Tatuapé, Santana, Pinheiros). ' +
        'NÃO chame se o lead pediu polo fora dessa lista — apenas conduza a conversa.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
          polo_id: {
            type: 'string',
            enum: ['sao_miguel', 'barra_funda', 'tatuape', 'santana', 'pinheiros'],
            description: 'ID do polo escolhido pelo lead.',
          },
        },
        required: ['telefone', 'polo_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_transferencia',
      description:
        'Inicia o ingresso por TRANSFERÊNCIA EXTERNA / aproveitamento de matérias. ' +
        'CHAME quando o lead quiser aproveitar/dispensar matérias, já cursou (ou cursa) outra faculdade e quer continuar/aproveitar, ' +
        'quer voltar a cursar aproveitando o que já fez, ou pedir transferência. ' +
        'Antes de chamar, colete e confirme: curso de origem (o que cursou/cursa), último semestre concluído e curso desejado na Sumaré. ' +
        'O servidor grava esses dados e segue para o polo + formulário (mesmo fluxo da matrícula). ' +
        'NÃO use para ingresso normal (vestibular ou pós sem transferência) — nesse caso use enviar_form_sumar_inscricao. ' +
        'NÃO chame se o lead só escolheu um número de lista de cursos, só pediu matrícula, ou se o "semestre" veio de data de nascimento/CPF.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
          curso_origem: {
            type: 'string',
            description: 'Nome do curso que o lead cursou ou está cursando na faculdade anterior (ex.: "Banco de Dados").',
          },
          semestre_concluido: {
            type: 'string',
            description: 'Último semestre que o lead concluiu na faculdade anterior (ex.: "2", "4º semestre").',
          },
          curso_desejado: {
            type: 'string',
            description: 'Curso que o lead quer cursar na Sumaré (ex.: "Sistemas de Informação"). EAD.',
          },
          polo_id: {
            type: 'string',
            enum: ['sao_miguel', 'barra_funda', 'tatuape', 'santana', 'pinheiros'],
            description: 'OPCIONAL — só informe se o lead já citou o polo nessa conversa.',
          },
        },
        required: ['telefone', 'curso_origem', 'semestre_concluido', 'curso_desejado'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_recebimento_formulario',
      description:
        'Confirma o recebimento do formulário preenchido e dispara a inscrição na API Captação Sumaré (gera link de aceite do contrato). ' +
        'CHAME quando o lead sinalizar que terminou de preencher o formulário ("pronto", "preenchi", "feito", "ok"), ' +
        'OU quando o sistema indicar que o Flow do WhatsApp recebeu as respostas. ' +
        'NÃO chame antes de o lead confirmar o envio.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
        },
        required: ['telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_grade_pdf',
      description:
        'Gera e envia a grade curricular completa em PDF pelo WhatsApp. ' +
        'CHAME OBRIGATORIAMENTE quando o lead pedir grade curricular, disciplinas, matérias, o que vai aprender, PDF ou arquivo da grade, ' +
        'ou quando o CONTEXT tiver LISTA DE DISCIPLINAS / STATUS PDF DISPONIVEL. ' +
        'Prioridade: enviar PDF pelo WhatsApp. PROIBIDO enviar link/URL do site oficial do curso ao lead (captação é por este canal). ' +
        'Funciona para graduação e pós-graduação (EAD, Semipresencial, Híbrido). ' +
        'IMPORTANTE: cursos com mais de um grau (ex.: Educação Física tem Bacharelado E Licenciatura) têm GRADES DIFERENTES — ' +
        'inclua o grau no campo "curso" (ex.: "Educação Física Licenciatura"). Se o lead não disse o grau, PERGUNTE antes de enviar.',
      parameters: {
        type: 'object',
        properties: {
          telefone: { type: 'string', description: 'Telefone do lead (Contexto do atendimento).' },
          curso: {
            type: 'string',
            description:
              'Nome do curso, INCLUINDO o grau quando o curso tiver mais de um (ex.: "Educação Física Licenciatura", "Educação Física Bacharelado", "Pedagogia").',
          },
          modalidade: {
            type: 'string',
            description: 'OPCIONAL — EAD, Semipresencial ou Híbrido, se souber.',
          },
          nivel: {
            type: 'string',
            enum: ['grad', 'pos'],
            description: 'OPCIONAL — grad ou pos, se souber.',
          },
          id_lead: {
            type: 'integer',
            description: 'OPCIONAL — id_lead do Kommo se estiver no Contexto.',
          },
        },
        required: ['telefone', 'curso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'distribuir_humano',
      description:
        'Inicia o FLUXO DE SAÍDA DO CANAL (não aciona consultor): a tool retorna a pergunta de confirmação que você deve enviar ao lead ' +
        '("prefere mesmo não seguir o atendimento por aqui?"). Se o lead confirmar, o sistema envia os links oficiais da Sumaré (atendimento e ouvidoria) e encerra. ' +
        'Use SOMENTE quando: (1) o lead pedir EXPLICITAMENTE humano/atendente/consultor; ' +
        '(2) negociação especial, reclamação grave, ou caso que a base de conhecimento não cobre após buscar_conhecimento/buscar_perguntas. ' +
        'NUNCA prometa que um consultor entrará em contato — isso não acontece mais. ' +
        'NÃO use para: informar curso, preços, dúvidas sobre matrícula, áudio do lead, ou "quero continuar com a matrícula" — nesses casos use buscar_conhecimento e conduza o atendimento; o formulário Form Sumar é disparado pelo sistema após confirmação do lead. ' +
        'O sistema localiza o lead pelo telefone automaticamente — você NÃO precisa passar id_lead se não souber.',
      parameters: {
        type: 'object',
        properties: {
          telefone: {
            type: 'string',
            description: 'Telefone/WhatsApp do lead (obrigatório). Pode ser só dígitos ou com +55.',
          },
          id_lead: {
            type: 'integer',
            description: 'ID do lead no Kommo. OPCIONAL — se você não souber, omita este campo (NÃO mande 0 nem inventado).',
          },
          motivo: {
            type: 'string',
            enum: ['consultor', 'matricula'],
            description:
              'consultor = dúvida/caso que a base não cobre ou pedido explícito de humano (NÃO aciona salesbot; inicia o fluxo de saída do canal). ' +
              'matricula = enviar template Form Sumar (NÃO dispara salesbot direto). Default: consultor.',
          },
        },
        required: ['telefone'],
      },
    },
  },
]

/** Tools expostas ao orquestrador — omite inscricao quando matrícula automática está desligada. */
export function getToolDefinitions(env = process.env) {
  if (isInscricaoAutomaticaEnabled(env)) return TOOL_DEFINITIONS
  return TOOL_DEFINITIONS.filter((t) => t.function?.name !== 'inscricao')
}

/**
 * Tools de "ação de inscrição" — quando o LLM chama uma destas e o executor retorna
 * `{ ok: true }`, o orquestrador descarta `msg.content` do LLM e usa o `text` da tool
 * como reply final. Garantia de que a narrativa do LLM nunca diverge do que o servidor fez.
 */
export const INSCRICAO_ACTION_TOOLS = new Set([
  'enviar_form_sumar_inscricao',
  'registrar_polo_inscricao',
  'registrar_transferencia',
  'confirmar_recebimento_formulario',
])

export function isInscricaoActionTool(name) {
  return INSCRICAO_ACTION_TOOLS.has(String(name || ''))
}

export const GRADE_ACTION_TOOLS = new Set(['enviar_grade_pdf'])

export function isGradeActionTool(name) {
  return GRADE_ACTION_TOOLS.has(String(name || ''))
}

export function isActionTool(name) {
  return isInscricaoActionTool(name) || isGradeActionTool(name)
}
