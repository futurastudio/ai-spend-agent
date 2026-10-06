"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import records from "../../landing/enterprise-tour.json";
import { projects, sources, totalCents, money, getDaySeries, getProjectSources } from "../scenario";
import { activityExamples } from "./activity-example";
import s from "./TraceNext.module.css";
import { WaitlistForm } from "../../WaitlistForm";
import { TerminalDemo } from "../../TerminalDemo";
import { TraceNavigation } from "./TraceNavigation";

type Project = (typeof projects)[number];
type Question = "where" | "why" | "attention";
type Product = "workspace" | "cli" | "mcp";
const questions: { id: Question; label: string; short: string; view: string }[] = [
  { id: "where", label: "Where did it go?", short: "Where it went", view: "Projects" },
  { id: "why", label: "What changed?", short: "What changed", view: "Overview" },
  { id: "attention", label: "What needs attention?", short: "Next step", view: "Briefing" },
];
const arrow = <span aria-hidden="true">↗</span>;
const sourceName = (name: string) => name === "Anthropic" ? "Claude" : name === "GitHub Copilot" ? "Copilot" : name;
const status = (name: string) => ["OpenAI", "Anthropic"].includes(name) ? "Invited Workspace access" : ["Cursor", "GitHub Copilot"].includes(name) ? "Guided Workspace beta" : "Planned coverage";

function Join({ children, className }: { children?: ReactNode; className?: string }) {
  return <a href="#beta" className={className}>{children || <>Join the waitlist {arrow}</>}</a>;
}

function Brand({ light = false }: { light?: boolean }) {
  return <img src={`/brand/lockup/tilden-lockup-horizontal-${light ? "white" : "ink"}.svg`} alt="Tilden" width="120" height="32" className={s.brand} />;
}

function BlueField({ children }: { children: ReactNode }) {
  const field = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const motion = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    let frame = 0;
    let x = 0;
    let y = 0;
    const paint = () => {
      element.style.setProperty("--field-x", `${x}px`);
      element.style.setProperty("--field-y", `${y}px`);
      frame = 0;
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      x = y = 0;
      paint();
      element.removeAttribute("data-pointer-active");
    };
    const move = (event: PointerEvent) => {
      if (!motion.matches || document.hidden || event.pointerType !== "mouse") return;
      const bounds = element.getBoundingClientRect();
      x = ((event.clientX - bounds.left) / bounds.width - .5) * 44;
      y = (Math.min(1, Math.max(0, (event.clientY - bounds.top) / 600)) - .5) * 28;
      element.dataset.pointerActive = "true";
      if (!frame) frame = requestAnimationFrame(paint);
    };
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerleave", reset);
    motion.addEventListener("change", reset);
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("blur", reset);
    return () => {
      reset();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", reset);
      motion.removeEventListener("change", reset);
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return <div ref={field} className={s.blueField}>
    <div className={s.fieldBackdrop} aria-hidden="true">
      <svg className={s.fieldTraces} viewBox="0 0 1440 640" preserveAspectRatio="xMidYMin slice">
        {Array.from({ length: 9 }, (_, index) => <path key={index} d={`M${730 + index * 58} -60 C${730 + index * 58} 130,${970 + index * 40} 90,${970 + index * 40} 240 S${570 + index * 64} 440,${620 + index * 64} 690`} />)}
      </svg>
      <svg className={s.fieldCrossings} viewBox="0 0 1440 640" preserveAspectRatio="xMidYMin slice">
        <path d="M550 90 H1510 M650 215 H1510 M750 340 H1510" />
        {[850, 1130, 1350].map((x, index) => <g key={x}><path d={`M${x - 4} ${90 + index * 125} h8 M${x} ${86 + index * 125} v8`} /><circle cx={x} cy={90 + index * 125} r="13" /></g>)}
      </svg>
    </div>
    {children}
  </div>;
}

function Navigation({ chooseProduct }: { chooseProduct: (product: Product) => void }) {
  return <header className={s.header}>
    <a href="#top" aria-label="Tilden home"><Brand light /></a>
    <TraceNavigation chooseProduct={chooseProduct} />
    <Join className={s.navCta} />
  </header>;
}

function SourceFlow({ project, selected, choose, paused, setPaused }: { project: Project; selected: string | null; choose: (name: string | null) => void; paused: boolean; setPaused: (value: boolean) => void }) {
  const flow = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [pulse, setPulse] = useState<{ index: number; key: number } | null>(null);
  const allocations = getProjectSources(project.id);
  const path = (index: number) => `M0 ${24 + index * 48} C85 ${24 + index * 48},70 144,140 144`;
  const mobilePath = (index: number) => `M${25 + index * 50} 0 C${25 + index * 50} 25,150 15,150 40`;
  useEffect(() => {
    if (!flow.current) return;
    let onScreen = false;
    const update = () => setVisible(onScreen && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; update(); });
    observer.observe(flow.current);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <div className={s.flow} ref={flow}>
    <div className={s.sourceHeading}><span>Across your sources</span><button onClick={() => choose(null)} aria-pressed={!selected}>All sources</button></div>
    <div className={s.flowGrid}>
      <div className={s.sourceRows}>{allocations.map((source, index) => <button type="button" key={source.name} aria-pressed={selected === source.name} aria-label={`${sourceName(source.name)}, ${money(source.cents)} sample cost. ${status(source.name)}`} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(index)} onBlur={() => setHover(null)} onClick={() => { choose(selected === source.name ? null : source.name); if (!paused) setPulse({ index, key: ++sequence.current }); }}>
        <img src={source.logo} alt="" width="24" height="24" /><span>{sourceName(source.name)}</span><b>{money(source.cents)}</b>
      </button>)}</div>
      <svg className={s.wires} viewBox="0 0 140 288" preserveAspectRatio="none" aria-hidden="true" data-paused={paused || !visible}>
        {allocations.map((source, index) => <path key={source.name} className={s.wire} data-active={hover === index || selected === source.name} d={path(index)} />)}
        {allocations.map((source, index) => <path key={`dot-${source.name}`} className={s.dot} pathLength="1" d={path(index)} style={{ "--call-delay": `${index * 1500}ms` } as CSSProperties} />)}
        {pulse && <path key={pulse.key} className={`${s.dot} ${s.directDot}`} pathLength="1" d={path(pulse.index)} onAnimationEnd={() => setPulse(null)} />}
      </svg>
      <svg className={s.mobileWires} viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true" data-paused={paused || !visible}>
        {allocations.map((source, index) => <path key={source.name} className={s.wire} data-active={selected === source.name} d={mobilePath(index)} />)}
        {allocations.map((source, index) => <path key={`dot-${source.name}`} className={s.dot} pathLength="1" d={mobilePath(index)} style={{ "--call-delay": `${index * 1500}ms` } as CSSProperties} />)}
        {pulse && <path key={pulse.key} className={`${s.dot} ${s.directDot}`} pathLength="1" d={mobilePath(pulse.index)} onAnimationEnd={() => setPulse(null)} />}
      </svg>
    </div>
    <div className={s.motionControl}><span>Illustrative agent calls</span><button onClick={() => setPaused(!paused)} aria-pressed={paused} aria-label={paused ? "Resume agent-call animation" : "Pause agent-call animation"}>{paused ? "Play" : "Pause"}<span aria-hidden="true">{paused ? "▷" : "Ⅱ"}</span></button></div>
  </div>;
}

function ActivityContext({ projectId }: { projectId: string }) {
  const activity = activityExamples[projectId] ?? [];
  return <section className={s.activityContext} aria-label="Sample coding-agent activity">
    <div className={s.activityHeading}><strong>Shared coding activity</strong><span>Sample activity</span></div>
    {activity.length ? <>
      <ul className={s.activityRows}>{activity.map(row => <li key={`${row.tool}-${row.repository}-${row.day}`}>
        <div><strong>{row.tool}</strong><span>{row.repository}</span></div>
        <time dateTime={row.day}>Sep {Number(row.day.slice(-2))} · UTC</time>
      </li>)}</ul>
      <p>See where coding agents were active. Activity is shown separately from billed costs.</p>
    </> : <p>No repository context linked in this example.</p>}
  </section>;
}

function FinancialAnswer({ project, selected, question, chooseQuestion }: { project: Project; selected: string | null; question: Question; chooseQuestion: (value: Question) => void }) {
  const [day, setDay] = useState<number | null>(null);
  const projectSources = getProjectSources(project.id);
  const source = projectSources.find(item => item.name === selected);
  const amount = source?.cents ?? project.cents;
  const series = selected ? getDaySeries(project.id).map(item => ({ ...item, cents: records.rows.filter(row => row.project === project.id && row.provider === selected && row.date === item.date).reduce((sum, row) => sum + row.cents, 0) })) : getDaySeries(project.id);
  const peak = series.reduce((a, b) => a.cents > b.cents ? a : b);
  const selectedDay = series.find(item => item.day === day) ?? peak;
  const organizationDay = getDaySeries().find(item => item.day === selectedDay.day)!;
  const largestSource = [...projectSources].sort((a, b) => b.cents - a.cents)[0];
  useEffect(() => { setDay(null); }, [project.id, selected]);
  const share = Math.round(amount / (source ? project.cents : totalCents) * 100);

  return <div className={s.answer}>
    <div className={s.answerContext}><span>{questions.find(item => item.id === question)?.view}</span><span>Sep 2026 · sample USD</span></div>
    <div className={s.answerBody} key={`${project.id}-${selected}-${question}`}>
      {question === "where" && <>
        <p className={s.amountContext}>{source ? `${sourceName(source.name)} / ${project.name}` : project.name}</p>
        <strong className={s.amount}>{money(amount)}</strong>
        <h3>{source ? `${share}% of this project’s cost.` : project.id === "unattributed" ? `${share}% still needs a project.` : `${share}% of the example bill.`}</h3>
        <p className={s.answerDetail}>{source ? status(source.name) : project.id === "unattributed" ? "Keep missing context visible. Review the source records before assigning the cost." : `Across six example sources. Organization total: ${money(totalCents)}.`}</p>
        <div className={s.contribution} aria-label={`${share}% contribution`}><i style={{ transform: `scaleX(${share / 100})` }} /></div>
        <button className={s.nextAction} onClick={() => chooseQuestion("why")}>Inspect the daily spending <span aria-hidden="true">→</span></button>
      </>}
      {question === "why" && <>
        <p className={s.amountContext}>{source ? `${sourceName(source.name)} / ` : ""}{project.name}</p>
        <div className={s.dayReadout} aria-live="polite"><strong>{money(selectedDay.cents)}</strong><span>September {selectedDay.day}{selectedDay.day === peak.day ? " · peak day" : ""}</span></div>
        <div className={s.chart} aria-label="Explore daily example spending">{series.map(item => <button type="button" key={item.day} aria-label={`September ${item.day}, ${money(item.cents)} sample cost`} aria-pressed={selectedDay.day === item.day} onMouseEnter={() => setDay(item.day)} onFocus={() => setDay(item.day)} onClick={() => setDay(item.day)} style={{ "--bar": item.cents / peak.cents } as CSSProperties}><span /></button>)}</div>
        <div className={s.chartScale}><span>01 SEP</span><span>15</span><span>30 SEP</span></div>
        <p className={s.chartFinding}>{Math.round(selectedDay.cents / organizationDay.cents * 100)}% of the organization’s {money(organizationDay.cents)} on this day. Review the workload and model mix to understand why.</p>
        <button className={s.nextAction} onClick={() => chooseQuestion("attention")}>See the next question <span aria-hidden="true">→</span></button>
      </>}
      {question === "attention" && <>
        <p className={s.amountContext}>Suggested investigation · example</p>
        <h3 className={s.briefingTitle}>{source ? `What is driving ${sourceName(source.name)} usage here?` : project.question}</h3>
        <p className={s.briefingText}>{source ? `${sourceName(source.name)} accounts for ${money(source.cents)} of ${money(project.cents)} in this project. Review its model mix and workloads before changing how work runs.` : project.briefing}</p>
        <dl className={s.evidence}><div><dt>Project cost</dt><dd>{money(project.cents)}</dd></div><div><dt>{source ? "Selected source" : "Largest source"}</dt><dd>{sourceName(source?.name ?? largestSource.name)}</dd></div></dl>
        <ActivityContext projectId={project.id} />
        <p className={s.smallPrint}>Cost identifies where to investigate. It does not establish the value of the work.</p>
        <button className={s.nextAction} onClick={() => chooseQuestion("why")}>Review the daily evidence <span aria-hidden="true">→</span></button>
      </>}
    </div>
  </div>;
}

function CLI() {
  const commands = [{ command: "npx aibill", title: "Read your local evidence", note: "Inspect supported local activity and cost evidence." }, { command: "npx aibill --group-by project", title: "Follow a project", note: "Group supported records by project. Missing attribution stays visible." }, { command: "npx aibill doctor --sources", title: "Check your sources", note: "Check which sources are working and how up to date they are." }];
  const [command, setCommand] = useState(0);
  const [feedback, setFeedback] = useState("");
  async function copy() { try { await navigator.clipboard.writeText(commands[command].command); setFeedback("Copied"); } catch { setFeedback("Select the command to copy it manually."); } }
  return <div className={s.cli}>
    <div className={s.cliIntro}><span className={s.pill}>Public · open source</span><h3>The same question.<br />Start at the command line.</h3><p>Inspect supported cost and activity on your machine. Share supported activity with Workspace when you choose.</p>
      <div className={s.cliSelection}>
        <label className={s.cliCommandSelect} htmlFor="cli-command">Explore a command<select id="cli-command" value={command} onChange={event => { setCommand(Number(event.target.value)); setFeedback(""); }}>{commands.map((item, index) => <option key={item.command} value={index}>{item.title}</option>)}</select></label>
        <p>{commands[command].note}</p>
      </div>
      <a href="/docs/cli">Read CLI documentation {arrow}</a>
    </div>
    <div className={s.cliRecording}>
      <div className={s.cliRecordingStack}>
        <figure><TerminalDemo variant="glass" /><figcaption><p>Styled CLI replay · sample data.</p><a href="/media/tilden-cli-glass.mp4" target="_blank" rel="noopener noreferrer">Open recording full size {arrow}</a></figcaption></figure>
        <div className={s.cliCommands}>
          <div className={s.command}><code>{commands[command].command}</code><button onClick={copy} aria-label="Copy CLI command">{feedback === "Copied" ? "Copied" : "Copy"}</button></div>
          <span className={s.copyStatus} role="status">{feedback}</span>
        </div>
      </div>
    </div>
  </div>;
}

function HostedMCP() {
  return <section id="hosted-mcp-panel" className={s.workspaceMcp} aria-labelledby="workspace-mcp-heading">
    <div><div className={s.mcpLabel}><span>Workspace / MCP</span></div><h3 id="workspace-mcp-heading">Spending answers,<br />in your AI tools.</h3><p>Use read-only Workspace cost evidence in compatible AI tools, so your team can investigate spending where it already works.</p><p>Workspace access is invitation-only.</p>
    </div>
    <div className={s.mcpConcept}><span>Illustrative example</span><blockquote>Which projects are driving our AI costs?</blockquote><div className={s.mcpFlow}><span>Your AI tool</span><span aria-hidden="true">→</span><span>Tilden Workspace</span></div><p>Read-only cost evidence.<br />No live connection in this preview.</p></div>
  </section>;
}

function MoneyStory({ product, setProduct }: { product: Product; setProduct: (product: Product) => void }) {
  const [projectId, setProjectId] = useState(projects[0].id);
  const [source, setSource] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question>("where");
  const [paused, setPaused] = useState(false);
  const project = projects.find(item => item.id === projectId)!;
  function navigateQuestion(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
    if (next === null) return;
    event.preventDefault(); setQuestion(questions[next].id); document.getElementById(`question-${questions[next].id}`)?.focus();
  }
  return <section id="example" aria-label="Follow the money, interactive product example" className={s.story}>
    <div className={s.stageHeader}>
      <div className={s.productSwitch} role="group" aria-label="Choose a Tilden product"><button id="product-workspace" aria-pressed={product === "workspace"} onClick={() => setProduct("workspace")}>Workspace</button><button id="product-cli" aria-pressed={product === "cli"} onClick={() => setProduct("cli")}>CLI</button><button id="workspace-mcp" aria-pressed={product === "mcp"} aria-controls={product === "mcp" ? "hosted-mcp-panel" : undefined} onClick={() => setProduct("mcp")}>MCP</button></div>
      {product === "workspace" ? <div className={s.demoNotice}><span>Sample data · includes planned sources</span><a href="#coverage">See current coverage {arrow}</a></div> : <span>{product === "cli" ? "CLI replay · sample data" : "Spending context for your AI tools"}</span>}
    </div>
    {product === "workspace" ? <>
      <div className={s.questions} role="tablist" aria-label="Choose a spending question">{questions.map((item, index) => <button role="tab" id={`question-${item.id}`} aria-controls="money-answer" aria-selected={question === item.id} tabIndex={question === item.id ? 0 : -1} key={item.id} onClick={() => setQuestion(item.id)} onKeyDown={event => navigateQuestion(event, index)}><span className={s.longQuestion}>{item.label}</span><span className={s.shortQuestion}>{item.short}</span><span aria-hidden="true">{question === item.id ? "↘" : "→"}</span></button>)}</div>
      <div className={s.storyContent}>
        <div className={s.flowSide}><label className={s.projectSelect}><span>Choose a project</span><select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><SourceFlow project={project} selected={source} choose={setSource} paused={paused} setPaused={setPaused} /></div>
        <div id="money-answer" role="tabpanel" aria-labelledby={`question-${question}`} tabIndex={0}><FinancialAnswer project={project} selected={source} question={question} chooseQuestion={setQuestion} /></div>
      </div>
      <p className={s.disclosure}>Sample data in USD · includes planned sources. <a href="#coverage">Current coverage {arrow}</a></p>
    </> : product === "cli" ? <CLI /> : <HostedMCP />}
  </section>;
}

const requestedSources = [
  { name: "AWS Bedrock", logo: "aws-bedrock.svg", wordmark: false },
  { name: "Hugging Face", logo: "hugging-face.svg", wordmark: false },
  { name: "Databricks", logo: "databricks.svg", wordmark: false },
  { name: "DeepSeek", logo: "deepseek.svg", wordmark: true },
];

function Coverage() {
  return <section id="coverage" className={s.coverage} aria-labelledby="coverage-heading">
    <div className={s.coverageHeading}><h2 id="coverage-heading">Start with your sources.</h2><p>Bring supported AI costs into one view. <a href="mailto:contact@asktilden.com?subject=Tilden%20source%20request&amp;body=Source%20I%27d%20like%20to%20request%3A%0A%0AThe%20AI%20spending%20question%20my%20team%20needs%20to%20answer%3A%0A">Request a source {arrow}</a></p></div>
    <div className={s.coverageMarks} role="group" aria-label="Sources and availability">
      <div className={s.coverageTrack}>
        {[false, true].map(duplicate => <ul key={String(duplicate)} className={s.coverageGroup} aria-hidden={duplicate || undefined}>
          {sources.map(source => <li key={source.name}><div className={s.coverageLogo}><img src={source.logo} width="30" height="30" alt={sourceName(source.name)} title={source.name} />{["Jev", "Kimi"].includes(source.name) ? <sup aria-label="by partner request">*</sup> : null}</div><span>{["OpenAI", "Anthropic"].includes(source.name) ? "Invited access" : ["Cursor", "GitHub Copilot"].includes(source.name) ? "Workspace beta†" : "Planned"}</span></li>)}
          {requestedSources.map(source => <li key={source.name}><div className={s.coverageLogo}><img src={`/brand/providers/${source.logo}`} width={source.wordmark ? 64 : 30} height="30" alt={source.name} title={source.name} className={source.wordmark ? s.coverageWordmark : undefined} /><sup aria-label="by partner request">*</sup></div><span>Planned</span></li>)}
        </ul>)}
      </div>
    </div>
    <details className={s.coverageDetails}>
      <summary>Coverage and setup details <span aria-hidden="true">+</span></summary>
      <div>
        <p><strong>Partner setup · OpenAI, Anthropic, Cursor + Copilot†.</strong> Connect OpenAI and Anthropic API costs with help from our team. † Cursor and Copilot are offered through a guided Workspace beta.</p>
        <p><strong>Spend in context.</strong> See project and model costs where your sources provide that detail. Choose to add Claude Code and Codex activity for a view of where coding agents are working.</p>
        <p><strong>* Planned · by partner request.</strong> AWS Bedrock, Hugging Face, Databricks, DeepSeek, Jev and Kimi are on the roadmap. Tell us which source your team needs next.</p>
      </div>
    </details>
  </section>;
}

function Ambition() {
  const [delegated, setDelegated] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const workforce = useRef<HTMLDivElement>(null);
  const taskPaths = ["M0 100 C55 100,30 34,90 34", "M0 100 H90", "M0 100 C55 100,30 166,90 166"];
  useEffect(() => {
    if (!workforce.current) return;
    let onScreen = false;
    const update = () => setVisible(onScreen && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; update(); }, { threshold: .15 });
    observer.observe(workforce.current);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <section id="ambition" className={s.ambition}>
    <div className={s.ambitionCopy}><p className={s.eyebrow}>The company we’re building</p><h2>More work delegated.<br />More to account for.</h2><p>As agents take on ongoing work, companies need to understand what it costs, who is responsible, and what it produces.</p><p className={s.missionEnd}>AI spend management is the first step. Financial infrastructure for that workforce is the mission.</p></div>
    <div className={s.workforce} ref={workforce} data-paused={paused || !visible}>
      <div className={s.workforceHeader}><span>Illustrative future concept</span><div role="group" aria-label="Explore the AI workforce"><button aria-pressed={!delegated} onClick={() => setDelegated(false)}>One assistant</button><button aria-pressed={delegated} onClick={() => setDelegated(true)}>Delegated work</button></div></div>
      <div key={String(delegated)} className={s.workforceDiagram} data-delegated={delegated}>
        <div className={s.person}><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="10" r="5" /><path d="M6 28v-3a10 10 0 0 1 20 0v3" /></svg><span>{delegated ? "A person supervises" : "A person directs"}</span></div>
        <svg className={s.workforceLines} viewBox="0 0 90 200" preserveAspectRatio="none" aria-hidden="true">
          {taskPaths.map((path, index) => <path key={`wire-${index}`} className={s.taskWire} data-active={delegated || index === 1} d={path} />)}
          {taskPaths.map((path, index) => (delegated || index === 1) && <path key={`call-${index}`} className={s.taskCall} pathLength="1" d={path} style={{ "--task-delay": `${delegated ? index * 1800 : 0}ms` } as CSSProperties} />)}
        </svg>
        <div className={s.agentWork}>{["Research", "Support", "Build"].map((label, index) => <div key={label} data-active={delegated || index === 1} style={{ "--task-delay": `${delegated ? index * 1800 : 0}ms` } as CSSProperties}><span aria-hidden="true">↗</span><span>{delegated ? label : index === 1 ? "One task" : label}</span><i aria-hidden="true" /></div>)}</div>
      </div>
      <div className={s.workforceMotion}><span>Illustrative agent calls</span><button onClick={() => setPaused(!paused)} aria-pressed={paused} aria-label={paused ? "Resume workforce animation" : "Pause workforce animation"}>{paused ? "Play" : "Pause"}<span aria-hidden="true">{paused ? "▷" : "Ⅱ"}</span></button></div>
      <p className={s.workforceAnswer} aria-live="polite">{delegated ? "The work keeps running. Who owns the cost, and was the result worth it?" : "One person, one task. The cost is easier to follow."}</p>
      <details className={s.futureDetails}><summary>Where we’re going <span aria-hidden="true">+</span></summary><p>We’re exploring task-aware model routing and connections between cost, responsibility and outcomes. These are future directions.</p></details>
    </div>
  </section>;
}

function FAQ() {
  return <section className={s.faq} aria-labelledby="faq-title"><h2 id="faq-title">Before you join.</h2><div>
    <details><summary>Who is Tilden for?<span aria-hidden="true">+</span></summary><p>Engineering leaders and founders responsible for explaining AI costs, together with finance teams and CFOs who need to understand spending and decide what deserves closer review.</p></details>
    <details><summary>Why not just use each provider’s dashboard?<span aria-hidden="true">+</span></summary><p>Provider dashboards each show a slice. Tilden brings supported cost reports alongside the agent activity your team chooses to share, so finance and engineering can explain spending together and decide where to investigate. Coverage gaps stay visible.</p></details>
    <details><summary>Can I track AI spend and agent activity across my team?<span aria-hidden="true">+</span></summary><p>Yes. Review supported AI costs by project and model alongside the coding-agent activity your team shares. The detail depends on each source and your setup; activity alone doesn’t establish the billed cost of a person or agent.</p></details>
    <details><summary>Does Tilden measure ROI?<span aria-hidden="true">+</span></summary><p>Tilden starts with the cost side. Measuring return also requires evidence of useful outcomes and a basis for comparison. That is part of our longer-term ambition.</p></details>
    <details><summary>What happens after I join?<span aria-hidden="true">+</span></summary><p>Our onboarding team will reach out to learn about your AI spend and help with next steps. Selected partners get guided setup and a spending review with our team.</p></details>
  </div></section>;
}

export default function TraceNext() {
  const [product, setProduct] = useState<Product>("workspace");
  useEffect(() => {
    const selectLinkedProduct = () => {
      const linkedProducts: Record<string, Product> = { "#product-workspace": "workspace", "#product-cli": "cli", "#workspace-mcp": "mcp" };
      const linkedProduct = linkedProducts[window.location.hash];
      if (linkedProduct) setProduct(linkedProduct);
    };
    selectLinkedProduct();
    window.addEventListener("hashchange", selectLinkedProduct);
    return () => window.removeEventListener("hashchange", selectLinkedProduct);
  }, []);
  return <div className={s.page} data-trace-next id="top">
    <a className={s.skip} href="#example">Skip to the example</a>
    <main>
      <BlueField><Navigation chooseProduct={setProduct} /><div className={s.hero}>
        <div><p className={s.eyebrow}>Building financial infrastructure for the AI workforce</p><h1>Your agents are doing more.<br /><span>Know where the money goes.</span></h1></div>
        <div className={s.heroAside}><p>For engineering leaders, founders, and finance teams who need to explain rising AI spend. Review supported provider costs and available project detail alongside the agent activity your team chooses to share, so you can see what needs attention.</p><div className={s.heroActions}><Join className={s.primary} /><a href="#example">Explore an example <span aria-hidden="true">↓</span></a></div><p className={s.offer}>Invited partners get guided setup and a spending review with our team.</p></div>
      </div><div className={s.stageWrap}><MoneyStory product={product} setProduct={setProduct} /></div></BlueField>
      <div className={s.content}><Coverage /><section className={s.solutionsBridge} aria-labelledby="solutions-heading">
        <div><p className={s.eyebrow}>Assisted services · invited partners</p><h2 id="solutions-heading">Which AI investments<br />deserve more budget?</h2><p>Start with costs you can explain. Then establish what a useful outcome would look like.</p></div>
        <div className={s.solutionLinks}>
          <a href="/solutions#spend-assessment"><span><strong>AI Spend Assessment</strong><small>Understand your AI costs and decide what to investigate next.</small></span>{arrow}</a>
          <a href="/solutions#value-pilot"><span><strong>AI Value Pilot</strong><small>Work with our team to define useful outcomes and a baseline for one workflow.</small></span>{arrow}</a>
        </div>
      </section><Ambition /><FAQ /><section id="beta" className={s.invitation} aria-labelledby="waitlist-heading"><div><h2 id="waitlist-heading">Make sense of<br />your AI spend.</h2><p>Bring the spending question engineering and finance need to answer. Invited partners get guided setup and a review of supported sources with our team.</p><p className={s.waitlistExpectation}>Join for product updates and access invitations. Workspace access is invitation-only; joining does not grant immediate access.</p></div><div className={s.signup}><WaitlistForm presentation="landing" /></div></section></div>
    </main>
    <footer className={s.footer}><a href="#top" aria-label="Tilden home"><Brand /></a><p>Financial infrastructure for the AI workforce.</p><nav aria-label="Footer navigation"><a href="/solutions">Solutions</a><a href="#ambition">Our ambition</a><a href="/docs">Docs</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:contact@asktilden.com">Contact</a></nav><span>© 2026 Tilden</span></footer>
  </div>;
}
