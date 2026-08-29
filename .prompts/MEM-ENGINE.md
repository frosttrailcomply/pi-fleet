Я прошёлся не только по Mem0 / OpenViking / Hindsight / Supermemory, а по широкому GitHub-ландшафту memory systems для агентов и отдельно посмотрел архитектуры, лицензии, production-ready признаки и доступные benchmark’и на **29 августа 2026**.

## Вердикт

Если заставить меня выбрать **один** general-purpose AI memory framework сегодня, мой выбор:

# **Hindsight**

[GitHub — vectorize-io/hindsight](https://github.com/vectorize-io/hindsight?utm_source=chatgpt.com)([GitHub][1])hindsight

Не потому, что он имеет больше stars — их у Mem0 намного больше. И не потому, что он выигрывает абсолютно каждую таблицу — этого сейчас нельзя честно утверждать.

Я выбираю Hindsight потому, что из всех рассмотренных систем он лучше всего сочетает **качество памяти + правильную архитектуру long-term learning + temporal reasoning + graph relations + consolidation + agent experience + production maturity + отсутствие vendor lock-in**. ([GitHub][2])

---

# 1. Что вообще нашлось на GitHub

GitHub-категория AI memory уже содержит **более тысячи репозиториев**, поэтому буквально перечислять каждый форк и эксперимент бессмысленно. Я отфильтровал системы, которые представляют самостоятельную архитектурную идею или имеют заметную production/research ценность. Актуальные curated-каталоги также уже выделяют несколько десятков dedicated memory systems и отдельно framework-native memory в LangGraph, LlamaIndex, CrewAI, AutoGen и т. д. ([GitHub][3])

Вот широкий shortlist:

| Framework                                                                                              | Основная идея                                                                                             | Моя категория                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Hindsight** — [GitHub](https://github.com/vectorize-io/hindsight?utm_source=chatgpt.com)             | World facts + experiences + observations + mental models; semantic/BM25/graph/temporal retrieval; Reflect | 🏆 full memory system            |
| **Mem0** — [GitHub](https://github.com/mem0ai/mem0?utm_source=chatgpt.com)                             | Fact extraction + entity linking + hybrid retrieval + temporal ranking                                    | 🏆 production memory             |
| **OpenViking** — [GitHub](https://github.com/volcengine/OpenViking?utm_source=chatgpt.com)             | Hierarchical context filesystem: memory + resources + skills                                              | 🏆 context database              |
| **Supermemory** — [GitHub](https://github.com/supermemoryai/supermemory?utm_source=chatgpt.com)        | Memory + RAG + profiles + connectors + multimodal ingestion                                               | 🏆 memory/context platform       |
| **Graphiti** — [GitHub](https://github.com/getzep/graphiti?utm_source=chatgpt.com)                     | Bi-temporal knowledge graph                                                                               | 🏆 temporal KG                   |
| **Zep**                                                                                                | Production platform built around temporal knowledge graphs                                                | production platform              |
| **Cognee** — [GitHub](https://github.com/topoteretes/cognee?utm_source=chatgpt.com)                    | Knowledge graph + vector memory/data pipelines                                                            | production knowledge memory      |
| **Letta** — [GitHub](https://github.com/letta-ai/letta?utm_source=chatgpt.com)                         | Stateful-agent runtime, agent-managed memory                                                              | agent OS                         |
| **MemMachine** — [GitHub](https://github.com/MemMachine/MemMachine?utm_source=chatgpt.com)             | Episodic/profile memory, ground-truth preservation                                                        | strong newcomer                  |
| **MemOS** — [GitHub](https://github.com/MemTensor/MemOS?utm_source=chatgpt.com)                        | Self-evolving “memory OS”                                                                                 | memory OS                        |
| **Memori** — [GitHub](https://github.com/MemoriLabs/Memori?utm_source=chatgpt.com)                     | Memory from agent execution + conversation, structured persistent state                                   | production infra                 |
| **memU** — [GitHub](https://github.com/NevaMind-AI/memU?utm_source=chatgpt.com)                        | Hierarchical/file-like shared memory                                                                      | hierarchical memory              |
| **ReMe** — [GitHub](https://github.com/agentscope-ai/ReMe?utm_source=chatgpt.com)                      | Markdown/file-native, traceable, correctable memory                                                       | local-first memory               |
| **Honcho** — [GitHub](https://github.com/plastic-labs/honcho?utm_source=chatgpt.com)                   | Continual representations of users/agents/groups                                                          | reasoning-first memory           |
| **Memobase** — [GitHub](https://github.com/memodb-io/memobase?utm_source=chatgpt.com)                  | User profiles + event timeline                                                                            | personalization                  |
| **OpenMemory** — [GitHub](https://github.com/CaviraOSS/OpenMemory?utm_source=chatgpt.com)              | SQL-native, temporal graph, local-first                                                                   | self-hosted memory               |
| **LangMem** — [GitHub](https://github.com/langchain-ai/langmem?utm_source=chatgpt.com)                 | Long-term memory primitives around LangGraph                                                              | framework-native                 |
| **A-MEM** — [GitHub](https://github.com/WujiangXu/A-mem-sys?utm_source=chatgpt.com)                    | Zettelkasten-inspired evolving memory network                                                             | research                         |
| **MemoryOS** — [GitHub](https://github.com/BAI-LAB/MemoryOS?utm_source=chatgpt.com)                    | Short/mid/long-term hierarchical memory                                                                   | research → usable                |
| **SimpleMem** — [GitHub](https://github.com/aiming-lab/SimpleMem?utm_source=chatgpt.com)               | Semantic compression → synthesis → intent-aware retrieval                                                 | research                         |
| **LightMem** — [GitHub](https://github.com/zjunlp/LightMem?utm_source=chatgpt.com)                     | Lightweight efficient memory-augmented generation                                                         | research                         |
| **Memvid** — [GitHub](https://github.com/memvid/memvid?utm_source=chatgpt.com)                         | Entire portable memory in one `.mv2` file                                                                 | storage/retrieval                |
| **MIRIX** — [GitHub](https://github.com/Mirix-AI/MIRIX?utm_source=chatgpt.com)                         | 6 memory types + multimodal/screen memory                                                                 | personal AI                      |
| **Memory-R1** — [GitHub](https://github.com/yansikuan/memory-r1?utm_source=chatgpt.com)                | RL-trained memory manager + answer agent                                                                  | research                         |
| **OMEGA** — [GitHub](https://github.com/omega-memory/omega-memory?utm_source=chatgpt.com)              | Local-first memory for coding agents                                                                      | coding-agent memory              |
| **agentmemory V4** — [GitHub](https://github.com/JordanMcCann/agentmemory?utm_source=chatgpt.com)      | Multi-signal retrieval + graph + consolidation                                                            | benchmark-heavy newcomer         |
| **Memary** — [GitHub](https://github.com/kingjulio8238/memary?utm_source=chatgpt.com)                  | Agent memory orchestration                                                                                | experimental                     |
| **Mastra Observational Memory** — [GitHub](https://github.com/mastra-ai/mastra?utm_source=chatgpt.com) | Observer/Reflector continuously compress agent history                                                    | framework-native                 |
| **PropMem** — внутри [ProsusAI/MemEval](https://github.com/ProsusAI/MemEval?utm_source=chatgpt.com)    | Atomic propositions + entity filtering                                                                    | fascinating minimal architecture |
| **claude-mem**                                                                                         | Persistent coding-agent memory                                                                            | coding-specific                  |
| **ByteRover/Cipher**                                                                                   | Shared memory for coding agents                                                                           | coding-specific                  |
| **Redis Agent Memory Server**                                                                          | Redis-backed agent memory service                                                                         | infra-specific                   |
| **Motorhead**                                                                                          | Long-term chat memory service                                                                             | older architecture               |
| **Second-Me**                                                                                          | Personal/self memory layer                                                                                | personal agents                  |
| **EverOS / related personal-memory projects**                                                          | Persistent context across tools                                                                           | specialized                      |

Отдельно существуют memory primitives внутри **LangGraph/LangChain, LlamaIndex, Semantic Kernel, CrewAI, AutoGen/AG2, Google ADK, OpenAI Agents SDK, Haystack**. Я не считаю их полноценными конкурентами Hindsight/Mem0 в этом сравнении: это прежде всего agent frameworks, куда memory входит как одна из подсистем. Обширная актуальная карта проектов подтверждает примерно такое же разделение. ([GitHub][4])

---

# 2. Настоящие финалисты

После отсечения research-only проектов, coding-only решений и решений, которые по сути являются RAG/knowledge graph, у меня остаются:

| Место | Система          | Что в ней особенно хорошо                                     |
| ----- | ---------------- | ------------------------------------------------------------- |
| **1** | **Hindsight**    | наиболее полноценная модель того, что значит «агент учится»   |
| **2** | **Mem0**         | лучший mainstream / самый безопасный ecosystem bet            |
| **3** | **OpenViking**   | лучший unified context layer: memory + knowledge + skills     |
| **4** | **Supermemory**  | лучший memory + RAG + connectors product                      |
| **5** | **MemMachine**   | очень сильная новая специализированная memory architecture    |
| **6** | **Graphiti/Zep** | лучший вариант, если temporal knowledge graph — центр системы |
| **7** | **Cognee**       | мощный knowledge/graph memory engine                          |
| **8** | **ReMe**         | один из самых интересных local-first/file-native подходов     |

И здесь начинается самое интересное.

---

# 3. Почему не Mem0

Mem0 сейчас — **намного сильнее, чем его репутация 2024–2025 годов**.

На 29 августа у open-source repo около **64.3k stars**, Apache-2.0 и огромная интеграционная экосистема. В апреле 2026 Mem0 поменял memory algorithm: single-pass ADD-only extraction, entity linking, parallel semantic + BM25 + entity retrieval и temporal reasoning. Собственные новые результаты Mem0: **92.5 LoCoMo, 94.4 LongMemEval, 64.1 BEAM-1M**, примерно 6.7–7k retrieved tokens и около секунды median latency в их production stack. ([GitHub][1])

Это делает Mem0 очень серьёзным кандидатом.

Но есть важная деталь: сам Mem0 прямо пишет, что эти числа относятся к **managed platform с proprietary optimizations**, отсутствующими полностью в OSS SDK. То есть `pip install mem0ai` ≠ система, которая буквально дала 94.4. ([GitHub][1])

И архитектурно Mem0 в 2026 всё ещё ближе к:

**conversation → extracted atomic facts → indexes/entities → retrieve**

чем к полноценной системе формирования внутренних знаний.

Это прекрасно для:

> «Пользователь живёт в Амстердаме»
> «Теперь он переехал в Берлин»
> «Предпочитает aisle seat»
> «Agent successfully completed operation X»

Но memory высокого уровня должна уметь не только сохранять факты.

Она должна формировать **обобщения из множества эпизодов**, хранить степень подтверждения, строить опыт, различать знание о мире и собственный опыт агента и уметь сознательно проводить reasoning над памятью.

И тут Hindsight идёт дальше.

---

# 4. Почему Hindsight архитектурно интереснее

В Hindsight память — не просто bag of facts.

Он разделяет её как минимум на:

**World facts → Experiences → Observations → Mental Models.**

При `retain` система извлекает факты, temporal information, entities и relationships. При `recall` одновременно запускаются **четыре retrieval path**:

semantic vector search + BM25 + graph traversal + temporal retrieval.

Потом результаты объединяются через fusion/reranking. ([GitHub][2])

Но ключевое преимущество даже не retrieval.

### Observations

Hindsight в фоне объединяет множество memories в более устойчивые **observations**.

Причём observation хранит supporting evidence и proof count; новая информация может его усиливать, ослаблять или расширять, вместо простого тупого overwrite. ([GitHub][2])

Условно:

```text
Memory 1:
User skipped morning meetings.

Memory 2:
User complained twice about early meetings.

Memory 3:
User consistently schedules important calls after 11:00.
```

обычная memory system хорошо хранит три факта.

Hindsight способен получить следующий уровень:

```text
Observation:
User strongly prefers important meetings after 11:00.
Evidence: 3 independent events.
```

А затем Mental Model может использовать множество observations для более общего понимания пользователя/проекта/мира.

Для меня именно здесь проходит граница между:

**database that remembers**

и

**memory system that learns**.

---

# 5. И у Hindsight при этом нет обычной проблемы research frameworks

Очень часто архитектурно красивый memory paper заканчивается папкой `notebooks/`.

Здесь иначе.

У Hindsight сейчас примерно **21.6k GitHub stars и 2,685 commits**, MIT license. Есть Docker, bare-metal Python package, embedded deployment, Kubernetes/Helm, managed cloud, PostgreSQL/pgvector и Oracle backend, Prometheus monitoring, webhooks, Python/Node/Go clients, REST и MCP. README заявляет 60+ integrations, включая LangGraph, LlamaIndex, CrewAI, Pydantic AI, OpenAI Agents SDK, Google ADK, AutoGen и coding agents. ([GitHub][2])

То есть это уже не «интересная статья».

Это настоящий infrastructure component.

---

# 6. А benchmarks?

Здесь надо быть особенно осторожным.

Hindsight v0.4.19 в собственном открытом Agent Memory Benchmark получил:

| Benchmark   | Hindsight |
| ----------- | --------: |
| LoCoMo      | **92.0%** |
| LongMemEval | **94.6%** |
| LifeBench   | **71.5%** |
| PersonaMem  | **86.6%** |

([GitHub][5])

Mem0 в своём новом evaluation stack показывает:

| Benchmark   |      Mem0 |
| ----------- | --------: |
| LoCoMo      | **92.5%** |
| LongMemEval | **94.4%** |
| BEAM 1M     | **64.1%** |

([GitHub][1])

То есть было бы нечестно сказать:

> «Hindsight просто намного точнее Mem0».

Нет.

На текущих vendor evaluations они практически **neck-and-neck**.

И разница 94.6 против 94.4 вообще не имеет для моего выбора значения.

---

# 7. Почему нельзя просто посмотреть leaderboard

Очень полезный reality check — независимый **ProsusAI/MemEval**.

Его авторы специально фиксируют одинаковые LLM, embeddings и scoring pipeline, потому что разные memory vendors обычно публикуют совершенно несопоставимые числа. И результаты резко меняются.

Например, на их LoCoMo run:

| System       |        F1 | LLM Judge |
| ------------ | --------: | --------: |
| **PropMem**  | **0.605** | **0.823** |
| OpenClaw     |      .557 |      .725 |
| Full Context |      .542 |      .709 |
| Hindsight    |      .489 |      .676 |
| Graphiti     |      .416 |      .573 |
| Memory-R1    |      .389 |      .569 |
| SimpleMem    |      .358 |      .478 |
| Mem0         |      .344 |      .497 |
| MemU         |      .299 |      .399 |

Это не означает «PropMem объективно лучший framework мира».

Это означает нечто важнее:

**benchmark score зависит от evaluator, версии системы, ingestion policy, LLM, embeddings, prompts и retrieval budget настолько сильно, что нельзя выбирать memory framework только по одному leaderboard.** ([GitHub][6])

Даже команда Hindsight отдельно отмечает, что изменения evaluation prompt/model могут сдвигать результат на двузначные проценты. ([GitHub][5])

Поэтому я гораздо больше смотрел на **архитектурные свойства + production characteristics + несколько независимых evaluation perspectives**.

---

# 8. Почему не OpenViking

OpenViking — пожалуй, **самый интересный конкурент Hindsight концептуально**.

[GitHub — OpenViking](https://github.com/volcengine/OpenViking?utm_source=chatgpt.com)

Он вообще ставит проблему шире.

Вместо:

```text
memory database
```

он делает:

```text
context database
├── memories
├── resources
└── skills
```

Всё представлено как виртуальная filesystem через `viking://`.

Причём данные и каталоги имеют три уровня:

```text
L0 = abstract
L1 = overview
L2 = full details
```

А retrieval способен сначала найти релевантный каталог, затем рекурсивно углубляться внутрь. Это очень сильная идея для long-horizon agents, потому что агенту действительно нужен не только факт о пользователе, но также прошлый опыт, проектные документы и приобретённые skills. ([GitHub][7])

У OpenViking уже около **34.1k stars**, production deployment, интеграции с Claude Code, Codex, Cursor, LangGraph, OpenClaw, Hermes и др.; часть underlying VikingMem research принята на VLDB 2026. ([GitHub][7])

И результаты собственного evaluation впечатляют: добавление OpenViking подняло LoCoMo у трёх agent integrations примерно до **80–83%**, одновременно снизив tokens на 34–91%; experience memory в tau2-bench повысила task success на +6.87 и +11.87 процентного пункта. ([GitHub][8])

Почему всё-таки №2–3, а не №1?

Потому что OpenViking оптимизирует более широкую проблему:

> **управление всем context агента**

а Hindsight глубже оптимизирует конкретно:

> **построение долговременной обучающейся памяти**.

Плюс основной OpenViking — **AGPLv3**, тогда как Hindsight MIT и Mem0 Apache-2.0. Для части коммерческих архитектур это ощутимое practical disadvantage. ([GitHub][7])

Если бы вопрос звучал **«лучший context engineering backend для coding/autonomous agent»**, я бы очень серьёзно рассматривал OpenViking №1.

Но для **memory framework** — Hindsight.

---

# 9. Почему не Supermemory

Supermemory — отличный продукт и, возможно, лучший вариант, если хочется:

**Memory + RAG + user profiles + Google Drive/Gmail/Notion/GitHub + PDFs/images/video/code** одной системой.

Он умеет temporal changes, contradictions, automatic forgetting, hybrid knowledge+personal memory retrieval и может работать локально. Сейчас repo имеет около **29.1k stars**, MIT. ([GitHub][9])

Но концептуально он сильнее похож на очень хороший:

**personalization/context platform**

чем на систему накопления agent cognition.

У Hindsight мне больше нравится distinction:

```text
raw evidence
      ↓
facts / experiences
      ↓
observations
      ↓
mental models
      ↓
reflection
```

Для настоящего lifelong agent это более фундаментальная abstraction.

---

# 10. Почему не Graphiti

Graphiti очень хорош.

Если мне скажут:

> «У меня события постоянно меняются, relationships критичны, мне нужно понимать что было истинно когда и когда система это узнала»

то **Graphiti/Zep** вполне может стать лучшим решением.

Его bi-temporal knowledge graph — одна из самых правильных архитектур для dynamic knowledge.

Но это всё-таки прежде всего **temporal knowledge graph engine**.

Hindsight фактически получает преимущества graph/temporal retrieval, но добавляет поверх них experience, observation consolidation и reflection. Поэтому для universal agent memory он шире.

---

# 11. Почему меня заинтересовал MemMachine

MemMachine — sleeper candidate.

У него очень хороший акцент на **ground-truth-preserving episodic memory + profile memory**, а опубликованные результаты показывали около **93% LongMemEvalS** и сильное сокращение token usage относительно некоторых конфигураций Mem0.

Но ecosystem существенно моложе: порядка нескольких тысяч stars против 21k Hindsight / 64k Mem0.

Я бы за ним следил очень внимательно — из нынешних молодых проектов он один из наиболее вероятных кандидатов перепрыгнуть лидеров.

---

# 12. Почему PropMem — очень важный контрпример

Самая интересная вещь во всём исследовании — возможно, PropMem.

Его архитектура гораздо проще:

```text
conversation
      ↓
atomic propositions
      ↓
entity tagging
      ↓
entity-filtered retrieval
      ↓
reasoning
```

И именно он неожиданно выиграл standardized MemEval как по LoCoMo, так и в доступном LongMemEval comparison. ([GitHub][6])

Это важный урок:

**сложнее ≠ автоматически лучше.**

Но я не выбрал PropMem как best ever, потому что пока это скорее compelling architecture/reference implementation внутри evaluation project, а не сопоставимый по эксплуатационной зрелости memory platform.

---

# 13. Моя итоговая оценка

Это уже не benchmark, а мой **engineering score**, поэтому его не надо воспринимать как научную метрику.

| Framework        | Memory architecture | Temporal / contradictions | Learning / consolidation | Agent experience | Production | Ecosystem |   Итог |
| ---------------- | ------------------: | ------------------------: | -----------------------: | ---------------: | ---------: | --------: | -----: |
| **Hindsight**    |               ★★★★★ |                     ★★★★★ |                    ★★★★★ |            ★★★★★ |      ★★★★★ |     ★★★★½ | **#1** |
| **Mem0**         |                ★★★★ |                     ★★★★★ |                     ★★★½ |             ★★★★ |      ★★★★★ |     ★★★★★ | **#2** |
| **OpenViking**   |               ★★★★½ |                      ★★★★ |                    ★★★★½ |            ★★★★★ |      ★★★★½ |     ★★★★½ | **#3** |
| **Supermemory**  |               ★★★★½ |                     ★★★★★ |                     ★★★★ |             ★★★½ |      ★★★★★ |     ★★★★★ | **#4** |
| **MemMachine**   |               ★★★★½ |                     ★★★★½ |                     ★★★★ |             ★★★★ |       ★★★½ |       ★★★ | **#5** |
| **Graphiti/Zep** |                ★★★★ |                     ★★★★★ |                      ★★★ |              ★★★ |      ★★★★★ |      ★★★★ | **#6** |
| **ReMe**         |                ★★★★ |                      ★★★★ |                    ★★★★½ |            ★★★★½ |       ★★★★ |      ★★★½ | **#7** |
| **Cognee**       |                ★★★★ |                      ★★★★ |                     ★★★½ |             ★★★★ |      ★★★★★ |     ★★★★½ | **#8** |

---

# 14. Почему в итоге Hindsight

Если свести всё исследование к одной формуле, то:

### Mem0

**Memory = хорошо отобранные и найденные факты.**

### Supermemory

**Memory = факты + profile + external context/RAG.**

### Graphiti

**Memory = temporal graph of entities/events.**

### OpenViking

**Memory = часть общей иерархической context filesystem агента.**

### Hindsight

**Memory = факты + события + собственный опыт + temporal/graph structure + накопленные выводы + модели понимания + reflection.**

Последнее определение ближе всего к тому, чего я хочу от долговременной памяти автономного AI.

И при этом это не academic toy, а MIT-licensed framework с Docker/Kubernetes/embedded deployment, production observability, десятками integrations и серьёзным GitHub traction. ([GitHub][2])

Поэтому мой **один** выбор:

## 🏆 **Hindsight — best overall AI memory framework as of August 29, 2026**

[Открыть Hindsight на GitHub](https://github.com/vectorize-io/hindsight?utm_source=chatgpt.com)

С очень небольшим отрывом от **Mem0**, и с **OpenViking** как потенциально более сильным выбором, если под «memory» понимать уже всю persistent context architecture агента.

И последнее существенное предостережение: буквально в августе 2026 появился **LongMemEval-V2** — 451 вручную подготовленный вопрос, до 500 multimodal agent trajectories / 115M tokens и тесты не только recall, но workflow knowledge, dynamic state, environment gotchas и experience. Большинство перечисленных систем ещё не имеют сопоставимых результатов на нём. Поэтому через несколько месяцев именно этот benchmark может заметно поменять расстановку сил. ([GitHub][10])

Если строить новый serious agent stack **сегодня**, я бы начал именно с **Hindsight**, а не с самописной vector-memory abstraction поверх Qdrant/Chroma.

[1]: https://github.com/mem0ai/mem0 "GitHub - mem0ai/mem0: Universal memory layer for AI Agents · GitHub"
[2]: https://github.com/vectorize-io/hindsight "GitHub - vectorize-io/hindsight: Hindsight: Agent Memory That Learns · GitHub"
[3]: https://github.com/topics/ai-memory?utm_source=chatgpt.com "ai-memory · GitHub Topics · GitHub"
[4]: https://github.com/Anandesh-Sharma/awesome-agentic-memory "GitHub - Anandesh-Sharma/awesome-agentic-memory: 🧠 The definitive curated map of memory for LLM agents — frameworks, research papers, benchmarks, taxonomy & deep dives. · GitHub"
[5]: https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/blog/2026-03-23-agent-memory-benchmark.mdx "hindsight/hindsight-docs/blog/2026-03-23-agent-memory-benchmark.mdx at main · vectorize-io/hindsight · GitHub"
[6]: https://github.com/ProsusAI/MemEval "GitHub - ProsusAI/MemEval: Benchmark suite for evaluating agent and LLM memory systems · GitHub"
[7]: https://github.com/volcengine/OpenViking/ "GitHub - volcengine/OpenViking: Self-evolving Context Database for AI Agents. Unify Agent Memory, Knowledge RAG and Skills. · GitHub"
[8]: https://github.com/volcengine/OpenViking/blob/main/README.md "OpenViking/README.md at main · volcengine/OpenViking · GitHub"
[9]: https://github.com/supermemoryai/supermemory "GitHub - supermemoryai/supermemory: Memory and context engine + app that is extremely fast, scalable, and can be run fully locally. The Memory API for the AI era. · GitHub"
[10]: https://github.com/xiaowu0162/LongMemEval-V2 "GitHub - xiaowu0162/LongMemEval-V2: Official repository for LongMemEval-V2 · GitHub"
