# Interview Agent - Versão Local

Assistente em tempo real para entrevistas técnicas de **Engenharia de Dados**. Captura o áudio da entrevista, transcreve as perguntas automaticamente e gera respostas técnicas especializadas usando IA.

## Pré-requisitos

- **Node.js** 18 ou superior
- **Chave da API da OpenAI** (para Whisper + GPT) — obtenha em [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

## Setup Rápido

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Edite o arquivo .env e coloque sua OPENAI_API_KEY

# 3. Iniciar o app (servidor + frontend)
npm run dev
```

Acesse **http://localhost:5173** no navegador.

## Como Usar

1. Abra o app no navegador (Chrome recomendado)
2. Escolha a fonte de áudio:
   - **Microfone**: captura o áudio ambiente (útil se o entrevistador fala pelo alto-falante)
   - **Áudio do Sistema**: captura o que sai do computador (ideal para Zoom, Google Meet, Teams). Ao selecionar, marque "Compartilhar áudio" na janela de seleção de tela/aba
3. O app captura trechos de áudio a cada 10 segundos, transcreve e gera a resposta automaticamente
4. As respostas aparecem em cards colapsáveis — clique para expandir/recolher
5. Use os controles para **Pausar**, **Retomar** ou **Encerrar** a sessão

## Estrutura do Projeto

```
interview-agent-local/
├── server/
│   ├── index.mjs          # Servidor Express (API REST)
│   └── setup-db.mjs       # Script de setup do banco SQLite
├── src/
│   ├── App.jsx             # Interface principal
│   ├── api.js              # Cliente HTTP para o backend
│   ├── useAudioCapture.js  # Hook de captura de áudio
│   ├── main.jsx            # Entry point React
│   └── index.css           # Estilos (Tailwind + tema escuro)
├── data/                   # Banco SQLite (criado automaticamente)
├── .env.example            # Template de variáveis de ambiente
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

## Tecnologias

| Componente | Tecnologia |
|---|---|
| Frontend | React 19 + Tailwind CSS 3 + Vite |
| Backend | Express + SQLite (better-sqlite3) |
| Transcrição | OpenAI Whisper API |
| Respostas IA | OpenAI GPT-4o-mini |
| Áudio | Web Audio API + MediaRecorder |

## Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `OPENAI_API_KEY` | Sim | Chave da API da OpenAI |
| `PORT` | Não | Porta do servidor (padrão: 3001) |
| `DEFAULT_LANGUAGE` | Não | Idioma para transcrição (padrão: pt) |

## Custos Estimados (OpenAI)

- **Whisper**: ~$0.006/minuto de áudio
- **GPT-4o-mini**: ~$0.15/1M tokens input, ~$0.60/1M tokens output
- Uma sessão de 1 hora com 20 perguntas custa aproximadamente **$0.10 a $0.30**

## Dicas

- Use **Chrome** para melhor compatibilidade com captura de áudio do sistema
- Para captura de áudio do sistema, selecione a **aba do navegador** onde está a videochamada (não a tela inteira)
- O banco de dados SQLite fica em `data/interview-agent.db` e persiste entre sessões
- Para limpar o histórico, basta deletar o arquivo do banco

## Solução de Problemas

**"Nenhuma faixa de áudio capturada"**: Ao usar áudio do sistema, certifique-se de marcar a opção "Compartilhar áudio" na janela de seleção.

**"Permissão de áudio negada"**: Verifique se o navegador tem permissão para acessar o microfone nas configurações do site.

**Transcrições imprecisas**: O Whisper funciona melhor com áudio claro. Reduza ruído de fundo e aumente o volume do entrevistador.
