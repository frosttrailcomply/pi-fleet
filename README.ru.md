[English](README.md) · **Русский** · [中文](README.zh.md) · [Deutsch](README.de.md)

# pi-fleet

Расширение для [Pi coding agent](https://github.com/earendil-works/pi), которое даёт Pi **самовосстанавливающийся флот моделей**: оно находит OpenAI-совместимые и Ollama-эндпоинты, следит за их состоянием и направляет каждый запрос на лучший из доступных с прозрачным переключением при сбое. Дополнительно — опциональный **Mixture of Agents** и **обучающаяся память**.

Всё работает рядом с собственными провайдерами Pi — они продолжают действовать без изменений. pi-fleet это пакет-расширение, а не форк.

## Что внутри

- **Динамический флот** — фоновое обнаружение (локальные seed-адреса, скрейпинг Censys без ключа или Censys API), проверки живости и замеры задержки/пропускной способности, circuit breaker на каждый эндпоинт и маршрутизация с весами по силе модели, задержке, пропускной способности, здоровью, надёжности и размеру контекста.
- **Прозрачный failover** — запрос, попавший на медленный или сломанный эндпоинт, повторяется на следующем по рангу; breaker размыкается после серии сбоев и восстанавливается сам.
- **Mixture of Agents (MoA)** — опционально. Запускает несколько моделей параллельно, а агрегатор синтезирует один ответ. Работает и с локальными, и с внешними провайдерами; корректно деградирует при отказе воркеров.
- **Память** — извлекает из результатов инструментов повторяющиеся ошибки и обходные решения и подставляет уместные перед ходом. Ограниченная и обратимая **самоэволюция** подстраивает конфигурацию флота под измеримую метрику. В качестве бэкенда используется [Hindsight](https://github.com/vectorize-io/hindsight), если он доступен, иначе — локальное SQLite-хранилище без зависимостей.

## Установка

```bash
pi install git:github.com/frosttrailcomply/pi-fleet      # или: pi install npm:pi-fleet
# либо подключить расширение напрямую:
pi -e /path/to/pi-fleet/src/ext/fleet-extension.ts
```

Одна эта команда настраивает всё, включая стек беззапросного обнаружения: при установке автоматически клонируется и ставится стек [browser-search](https://github.com/Johell1NS/browser-search), скачивается и запускается его контейнер Camofox (camoufox) (шаг `postinstall` в `npm`), и генерируется нужная учётка. Больше ничего запускать не надо.

**Требования:** Node ≥ 22 (встроенный `node:sqlite`), `git`, и `podman` либо `docker` (для контейнера Camofox). При первой установке скачивается образ браузера. Чтобы отключить автоматическую установку стека, задайте `PI_FLEET_SKIP_SETUP=1`. Pi находит расширение по ключу `pi` в `package.json`.

## Настройка

Положите `fleet.config.json` в рабочую директорию, в `~/.pi/agent/` или укажите путь через `PI_FLEET_CONFIG`. Все поля необязательны; значения по умолчанию — в [`examples/fleet.config.json`](examples/fleet.config.json). Чаще всего меняют:

```jsonc
{
  "gatewayPort": 47600,             // локальный порт, с которым общается Pi (см. «Как это устроено»)
  "discovery": {
    "seeds": ["127.0.0.1:11434"],   // локальный Ollama и любые ваши host:port
    "censys": {
      "enabled": true,
      "query": "host.services.software.product = \"ollama\" or web.software.product = \"ollama\"",
      "browser": { "enabled": true } // скрейпинг без ключа (по умолчанию) — см. ниже
    }
  },
  "routing": { "capability": 1.0, "latency": 0.8, "throughput": 0.5, "health": 1.2, "reliability": 1.0, "context": 0.3 },
  "moa": { "enabled": false, "workers": 3, "policy": "diverse", "aggregatorModel": "", "minWorkers": 1 },
  "memory": { "enabled": true, "backend": "hindsight", "fallbackToNative": true },
  "evolution": { "enabled": false, "autoApply": false },
  "providers": [                    // внешние / локальные OpenAI-совместимые эндпоинты в пуле
    { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "$OPENROUTER_API_KEY",
      "models": [{ "id": "meta-llama/llama-3.1-70b-instruct", "sizeB": 70, "contextWindow": 131072 }] }
  ]
}
```

### Обнаружение (по умолчанию — без ключа)

Веб-интерфейс Censys закрыт Cloudflare и требует входа, поэтому обычный HTTP-запрос возвращает только страницу-заглушку. Поэтому pi-fleet рендерит результаты через стек [browser-search](https://github.com/Johell1NS/browser-search) (стелс-браузер Camofox / camoufox) и вытаскивает host:port из отрендеренного HTML — **без ключа Censys API**.

Это работает из коробки: стек ставится и его контейнер Camofox запускается за вас при [установке](#установка), а расширение в начале каждой сессии проверяет, что контейнер запущен. Ключ `CAMOFOX_API_KEY` генерируется один раз и хранится в `~/.pi/agent/fleet/`; расширение и CLI подхватывают его сами — ничего экспортировать не нужно.

Если понадобится переустановить или перезапустить вручную:

```bash
npm run setup:browser-search   # переустановить стек и запустить Camofox на 127.0.0.1:9377
npm run setup:camofox          # только перезапустить контейнер
```

Подойдёт любой фетчер, печатающий отрендеренный HTML — укажите его в `discovery.censys.browser.command`. Например, Firecrawl:

```jsonc
"command": ["firecrawl", "scrape", "{url}", "--format", "html", "--wait-for", "9000"],
"resultPath": ""
```

**Ротация прокси (опционально).** Censys ограничивает анонимные запросы по IP, поэтому частые обращения с одного адреса рано или поздно возвращают страницу с требованием входа. Задайте `discovery.censys.proxy.enabled: true`, чтобы прогонять скрейп через бесплатные прокси из [proxifly/free-proxy-list](https://github.com/proxifly/free-proxy-list) и [proxygenerator1/ProxyGenerator](https://github.com/proxygenerator1/ProxyGenerator) — пул скачивает список и **проверяет каждый прокси, оставляя только рабочие** (сначала самые быстрые). Бесплатные прокси медленные и нестабильные, поэтому по умолчанию выключено; включайте для непрерывного частого обнаружения.

Источники складываются: `discovery.seeds`, сохранённые страницы Censys через `discovery.censys.htmlImports` и Censys API при заданных `CENSYS_API_ID` / `CENSYS_API_SECRET`. Найденные хосты проверяются (`/api/tags` → реальный chat completion), и во флот попадают только подтверждённые эндпоинты. Живой прогон без ключа по этому пути обнаружил 70+ доступных эндпоинтов.

> Направляйте обнаружение только на те эндпоинты, которые вам разрешено использовать.

### Бэкенд памяти

По умолчанию `memory.backend` равен `"hindsight"`. При старте pi-fleet опрашивает сервис Hindsight (`memory.hindsight.baseUrl`); если он отвечает, уроки сохраняются и извлекаются оттуда. Если нет, а `fallbackToNative` включён (по умолчанию), берётся локальное SQLite-хранилище — память работает без внешнего сервиса. Нативное хранилище работает всегда, потому что на нём держится самоэволюция.

Поднимите Hindsight сами (Docker/Postgres) по его документации, затем задайте `memory.hindsight.baseUrl` и при необходимости `HINDSIGHT_API_KEY`.

## Использование в Pi

Выберите флот как модель:

```bash
pi --provider fleet --model auto                          # маршрутизация с весами + failover
pi --provider fleet --model moa                           # Mixture of Agents (при moa.enabled)
pi --provider fleet --model "127.0.0.1:11434/llama3.1:70b" # закрепить конкретную найденную модель
```

Команды:

| Команда | Действие |
|---|---|
| `/fleet` | Эндпоинты, здоровье, состояние breaker, модели, бэкенд памяти |
| `/fleet-refresh` | Немедленно обновить обнаружение и здоровье |
| `/fleet-moa on\|off` | Включить/выключить Mixture of Agents |
| `/fleet-evolve` | Прогнать один цикл самоэволюции сейчас |
| `/fleet-remember <текст>` | Сохранить факт об окружении / урок |

## Отдельный CLI

Управление флотом без запуска Pi:

```bash
npm run fleetctl -- discover        # один проход обнаружения + здоровья, вывести статус
npm run fleetctl -- status
npm run fleetctl -- import page.html   # извлечь host:port из сохранённой страницы Censys
npm run fleetctl -- chat "привет"   # прогнать один запрос через флот
npm run fleetctl -- memory          # показать сохранённые уроки
```

## Как это устроено

Pi общается с небольшим локальным **шлюзом** (`gatewayPort`) как с обычным OpenAI-совместимым провайдером. Шлюз направляет каждый запрос через движок, поэтому вся работа Pi с моделями остаётся на штатном пути:

```
обнаружение (seeds / браузер-скрейп / Censys API) → проба → реестр (EWMA-статистика + circuit breaker)
                                                             │
        запрос ──► роутер (взвешенный балл) ──► failover-исполнитель ──► эндпоинт
                                                    └► MoA: параллельные воркеры → агрегатор
наблюдения ──► память (Hindsight или нативный SQLite) ──► самообучение / самоэволюция
```

- **Circuit breaker** — `failureThreshold` подряд идущих сбоев размыкают эндпоинт; через `cooldownMs` он переходит в half-open на пробу; `recoveryThreshold` успехов замыкают его обратно.
- **Самоэволюция** — ограниченная и обратимая. Автоматически применяются только изменения *конфигурации* (карантин нестабильного эндпоинта, подстройка весов маршрутизации), которые измеримо улучшают метрику; иначе — откат. Всё, что затрагивает код или навыки, записывается как отслеживаемое git-предложение только для ревью в `.pi/fleet-evolution/`.

Временное состояние — в `~/.pi/agent/fleet/` (база нативной памяти, артефакты эволюции). Ничего чувствительного в git не попадает.

## Тесты

```bash
npm test          # модульные + интеграционные + end-to-end (внутрипроцессные моки; без внешних хостов)
npm run typecheck
```

End-to-end набор (`test/e2e.test.ts`) покрывает обнаружение и обновление, переходы состояния здоровья, маршрутизацию, прозрачный failover, восстановление эндпоинта, совместную работу локальных и внешних провайдеров, успех и частичный отказ воркеров MoA, сохранение и извлечение уроков, плановые циклы, приём и откат самоэволюции, а также чистый перезапуск с сохранённым состоянием.

## Удаление

```bash
pi remove git:github.com/frosttrailcomply/pi-fleet   # убрать расширение из Pi
npm run uninstall:stack                              # в каталоге пакета: удалить контейнер Camofox, клон browser-search и сохранённую учётку
```

Добавьте `--purge`, чтобы удалить и локальную базу памяти: `node scripts/uninstall.mjs --purge`.

## Благодарности

Проект опирается на работу:

- **[browser-search](https://github.com/Johell1NS/browser-search)** от [@Johell1NS](https://github.com/Johell1NS) — стек Camofox (camoufox) / CloakBrowser, обеспечивающий обнаружение через Censys без ключа.
- **[Pi coding agent](https://github.com/earendil-works/pi)** от [earendil-works](https://github.com/earendil-works) — агент, который расширяет этот пакет.
- **[Hindsight](https://github.com/vectorize-io/hindsight)** от [vectorize-io](https://github.com/vectorize-io) — бэкенд памяти по умолчанию.
- **[Firecrawl](https://github.com/firecrawl/firecrawl)** — альтернативный фетчер отрендеренного HTML для обнаружения.

Конвейер обнаружения начинался как пара Python-скриптов (`extract_ollama_hosts.py`, `ollama_recon.py`) и был портирован на TypeScript.

## Лицензия

MIT — см. [LICENSE](LICENSE).
