"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import s from "./TraceNavigation.module.css";

type Product = "workspace" | "cli" | "mcp";

function Dropdown({ label, current, children }: { label: string; current?: boolean; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closing, setClosing] = useState(false);
  function cancelClose() {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    leaveTimer.current = closeTimer.current = null;
    setClosing(false);
  }
  function closeMenu(immediate = false) {
    cancelClose();
    if (!menu.current?.open) return;
    if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      menu.current.open = false;
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      if (menu.current) menu.current.open = false;
      closeTimer.current = null;
      setClosing(false);
    }, 140);
  }
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);
  return <details ref={menu} className={s.menu} data-closing={closing}
    onPointerEnter={cancelClose}
    onPointerLeave={event => {
      if (event.pointerType !== "mouse" || !menu.current?.open || menu.current.querySelector(":focus-visible")) return;
      leaveTimer.current = setTimeout(() => closeMenu(), 80);
    }}
    onFocusCapture={cancelClose}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeMenu(); }}
    onToggle={event => {
      if (!event.currentTarget.open) { cancelClose(); return; }
      event.currentTarget.parentElement?.querySelectorAll("details[open]").forEach(other => {
        if (other !== event.currentTarget) other.removeAttribute("open");
      });
    }}
    onClick={event => { if (event.target instanceof Element && event.target.closest("a")) closeMenu(true); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeMenu(true); menu.current?.querySelector("summary")?.focus(); } }}>
    <summary aria-current={current ? "page" : undefined}>{label} <span aria-hidden="true">⌄</span></summary>
    <div className={s.dropdown}>{children}</div>
  </details>;
}

export function TraceNavigation({ chooseProduct, solutionsPage = false }: { chooseProduct?: (product: Product) => void; solutionsPage?: boolean }) {
  const productLink = (hash: string) => `${chooseProduct ? "" : "/"}${hash}`;
  const solutionLink = (hash: string) => `${solutionsPage ? "" : "/solutions"}${hash}`;
  return <nav className={s.nav} aria-label="Main navigation" data-solutions-page={solutionsPage}>
    <Dropdown label="Products">
      <div role="group" aria-label="Workspace">
        <a href={productLink("#product-workspace")} onClick={() => chooseProduct?.("workspace")}><strong>Workspace</strong><small>Review AI spending with your team</small></a>
        <a className={s.mcpMenu} href={productLink("#workspace-mcp")} onClick={() => chooseProduct?.("mcp")}><span><strong>MCP</strong></span><small>Spending context for your AI tools</small></a>
      </div>
      <a href={productLink("#product-cli")} onClick={() => chooseProduct?.("cli")}><strong>CLI</strong><small>Inspect cost and activity locally</small></a>
    </Dropdown>
    <Dropdown label="Solutions" current={solutionsPage}>
      <a href={solutionLink("#spend-assessment")}><strong>AI Spend Assessment</strong><small>Explain supported costs and what needs attention</small></a>
      <a href={solutionLink("#value-pilot")}><strong>AI Value Pilot</strong><small>Define a useful outcome baseline with our team</small></a>
    </Dropdown>
    <a href="/docs">Docs</a>
  </nav>;
}
