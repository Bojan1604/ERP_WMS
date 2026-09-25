'use client';

import { useCallback, useLayoutEffect, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/** Željena visina padajućeg popisa (polje za pretragu + ~8 redaka). */
const PREFERRED = 340;
/** Ispod ovoliko mjesta popis se okreće prema gore (ako gore ima više mjesta). */
const MIN_BELOW = 220;
const GAP = 4;
const EDGE = 8;

interface Pos {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Donji rub za popis: vidljivi dio zaslona (tipkovnica na mobitelu) i donja navigacija (fiksni <nav> pri dnu). */
function bottomLimit(inDialog: boolean) {
  const vv = window.visualViewport;
  let limit = vv ? vv.offsetTop + vv.height : window.innerHeight;
  if (inDialog) return limit; // modalni dijalog je iznad navigacije
  for (const nav of document.querySelectorAll('nav')) {
    if (getComputedStyle(nav).position !== 'fixed') continue;
    const r = nav.getBoundingClientRect();
    if (!r.height || r.top < window.innerHeight / 2) continue;
    let top = r.top;
    // plutajući gumb (Skeniraj) viri iznad trake
    for (const el of nav.querySelectorAll('a, button')) top = Math.min(top, el.getBoundingClientRect().top);
    limit = Math.min(limit, top);
  }
  return limit;
}

function place(anchor: HTMLElement, minWidth: number, inDialog: boolean): Pos {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const width = Math.min(Math.max(r.width, minWidth), vw - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(r.left, vw - width - EDGE));
  const below = bottomLimit(inDialog) - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  if (below >= Math.min(PREFERRED, MIN_BELOW) || below >= above) return { left, width, top: r.bottom + GAP, maxHeight: Math.max(120, Math.min(PREFERRED, below)) };
  return { left, width, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.min(PREFERRED, above) };
}

/**
 * Padajući sloj uz okidač (`anchor`) — `position: fixed` u portalu, pa ga ne reže `overflow`
 * roditelja (tijelo dijaloga, tablica, kartica). Unutar <dialog> portal ide u sam dijalog
 * (gornji sloj preglednika), inače u <body>. Ako ispod nema mjesta (dno ekrana, donja
 * navigacija na mobitelu, tipkovnica), otvara se prema gore; kad nema mjesta ni gore,
 * okidač se pomakne na sredinu zaslona.
 */
export function Popover({
  anchor,
  open,
  children,
  className,
  minWidth = 256,
  panelRef,
  id,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  children: ReactNode;
  className?: string;
  minWidth?: number;
  panelRef?: Ref<HTMLDivElement>;
  id?: string;
}) {
  const [pos, setPos] = useState<Pos | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  const update = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    setPos(place(a, minWidth, !!a.closest('dialog')));
  }, [anchor, minWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchor.current;
    if (!a) return;
    const dialog = a.closest('dialog');
    setHost(dialog ?? document.body);
    // ni gore ni dolje nema mjesta (npr. polje uz sam rub na mobitelu) — pomakni okidač u sredinu
    const r = a.getBoundingClientRect();
    if (bottomLimit(!!dialog) - r.bottom < 160 && r.top < 160) a.scrollIntoView({ block: 'center' });
    update();
    const vv = window.visualViewport;
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
    };
  }, [open, anchor, update]);

  if (!open || !host || !pos) return null;
  const style: CSSProperties = { left: pos.left, width: pos.width, maxHeight: pos.maxHeight, top: pos.top, bottom: pos.bottom };
  return createPortal(
    <div
      ref={panelRef}
      id={id}
      data-popover-open=""
      style={style}
      className={cn('fixed z-[60] flex flex-col overflow-hidden rounded-lg bg-panel text-base text-fg shadow-[var(--shadow-pop)]', className)}
    >
      {children}
    </div>,
    host,
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab iz padajućeg popisa (koji je u portalu na kraju dokumenta) — fokus ide na sljedeće
 * (ili s Shiftom prethodno) polje nakon okidača, kao da popisa nije bilo.
 */
export function focusAfter(trigger: HTMLElement, backwards = false) {
  const root: ParentNode = trigger.closest('dialog') ?? document;
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el === trigger || (!el.closest('[data-popover-open]') && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed')),
  );
  const i = all.indexOf(trigger);
  const next = i < 0 ? null : all[backwards ? i - 1 : i + 1];
  (next ?? trigger).focus();
}
