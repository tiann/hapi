/** Minimal valid sources for Playwright lightbox coverage (one case per diagram kind). */
export const MERMAID_LIGHTBOX_CASES = {
    flowchart: `flowchart LR
  Hub --> WebUI
  WebUI --> Lightbox`,

    sequence: `sequenceDiagram
  participant U as Operator
  participant C as Chat
  participant M as Mermaid
  U->>C: Send message
  C->>M: Render SVG
  M-->>U: Lightbox`,

    class: `classDiagram
  Animal <|-- Duck
  Animal : +int age
  Duck : +swim()`,

    state: `stateDiagram-v2
  [*] --> Still
  Still --> Moving
  Moving --> Still`,

    er: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE-ITEM : contains`,

    journey: `journey
  title Checkout
  section Browse
    Open site: 5: User
    Add item: 3: User`,

    gantt: `gantt
  title Plan
  dateFormat YYYY-MM-DD
  section Build
  Ship feature :2024-06-01, 3d`,

    pie: `pie title Pets
  "Dogs" : 386
  "Cats" : 214`,

    quadrant: `quadrantChart
  title Reach and engagement
  x-axis Low Reach --> High Reach
  y-axis Low Engagement --> High Engagement
  quadrant-1 We should expand
  Product A: [0.3, 0.6]
  Product B: [0.45, 0.23]`,

    requirement: `requirementDiagram
  requirement test_req {
    id: 1
    text: the tested requirement.
    risk: high
    verifymethod: test
  }`,

    gitGraph: `gitGraph
  commit
  branch develop
  checkout develop
  commit
  checkout main
  merge develop`,

    c4: `C4Context
  title System
  Person(user, "User")
  System(app, "Application")
  Rel(user, app, "Uses")`,

    mindmap: `mindmap
  root((HAPI))
    Chat
    Hub
    Web`,

    timeline: `timeline
  title History
  2024 : Alpha
  2025 : Beta`,

    kanban: `kanban
  title Board
  column Todo
    task1[Task 1]
  column Done
    task2[Task 2]`,
} as const

export type MermaidLightboxCaseId = keyof typeof MERMAID_LIGHTBOX_CASES

export const MERMAID_LIGHTBOX_CASE_IDS = Object.keys(MERMAID_LIGHTBOX_CASES) as MermaidLightboxCaseId[]
