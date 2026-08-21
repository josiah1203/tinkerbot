import { Blobatar } from "@blobatar/react";
import { happy, idle, thinking } from "blobatar/expression";
import "blobatar/motion.css";
import { createRoot, type Root } from "react-dom/client";

type ExpressionName = "happy" | "idle" | "thinking";

const expressions: Record<ExpressionName, typeof idle> = { happy, idle, thinking };
const roots = new Map<Element, Root>();

function ensureMotionStyles() {
  if (document.querySelector('link[data-tinkerbot-mascot-motion]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/mascot-island.css";
  link.dataset.tinkerbotMascotMotion = "true";
  document.head.append(link);
}

function expressionFor(value: string | undefined) {
  return expressions[value as ExpressionName] ?? idle;
}

function Mascot({ slot, expression }: { slot: string; expression?: string }) {
  const size = slot === "hero" ? 168 : slot === "onboarding" ? 112 : 72;
  return (
    <Blobatar
      name="alain00"
      traits={{ shape: 0.35 }}
      hue={275}
      animate="hover"
      expression={expressionFor(expression)}
      size={size}
      aria-hidden="true"
      focusable="false"
    />
  );
}

export function mountTinkerbotMascots(scope: ParentNode = document) {
  ensureMotionStyles();
  scope.querySelectorAll<HTMLElement>("[data-tinkerbot-mascot]").forEach((element) => {
    const slot = element.dataset.tinkerbotMascot;
    if (!slot || roots.has(element)) return;
    const root = createRoot(element);
    roots.set(element, root);
    root.render(<Mascot slot={slot} expression={element.dataset.expression} />);
  });
}

export function disposeTinkerbotMascots() {
  roots.forEach((root) => root.unmount());
  roots.clear();
}

window.__tinkerbotDisposeMascots = disposeTinkerbotMascots;
