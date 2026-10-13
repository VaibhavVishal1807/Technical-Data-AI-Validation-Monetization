/**
 * FloatingDock: a vertical, macOS-style dock used as the main navigation.
 * Icons sit in glass circles and grow as the mouse approaches; the page name
 * appears in a label to the right of the hovered icon.
 *
 * Adapted from Aceternity UI's "Floating Dock"
 * (`npx shadcn@latest add @aceternity/floating-dock`, https://ui.aceternity.com).
 * The original is a horizontal dock styled with Tailwind. Changes:
 *  1. Vertical: magnification follows the mouse's Y position, the stack grows
 *     downwards and the label appears to the right instead of above.
 *  2. Uses the mouse position relative to the screen (clientY) rather than the
 *     page (pageY), so the right icon grows even when the page is scrolled.
 *  3. Links are React Router NavLinks (no page reload, so the live WebSocket
 *     and alert feed survive navigation) and the current page is highlighted.
 *  4. Keyboard users get the label on focus; links have accessible names.
 *  5. No growth animation when the OS asks for reduced motion.
 *  6. Plain CSS (index.css, "Floating dock") so the glass look is in one
 *     place; lucide icons instead of @tabler/icons-react. Phones get
 *     MobileDock below instead of the original's pop-out button, because
 *     touch screens have no hover.
 */
import { useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
// LazyMotion + m (instead of the full motion components) loads only the DOM
// animation features the dock needs, which keeps the bundle smaller.
import {
  AnimatePresence,
  LazyMotion,
  domAnimation,
  m,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';

const BASE = 44; // circle size at rest (px)
const MAX = 66; // circle size right under the mouse
const ICON_BASE = 18;
const ICON_MAX = 28;
const REACH = 120; // how far (px) from the mouse an icon starts to grow
const SPRING = { mass: 0.1, stiffness: 150, damping: 12 };

/**
 * items: [{ title, to, icon: Component, end }]
 */
export function FloatingDock({ items }) {
  // Mouse Y on screen; Infinity means "not over the dock" (everything at rest).
  const mouseY = useMotionValue(Infinity);
  return (
    <LazyMotion features={domAnimation} strict>
      <m.nav
        className="dock"
        aria-label="Main"
        onMouseMove={(e) => mouseY.set(e.clientY)}
        onMouseLeave={() => mouseY.set(Infinity)}
      >
        {items.map((item) => (
          <DockItem key={item.to} mouseY={mouseY} {...item} />
        ))}
      </m.nav>
    </LazyMotion>
  );
}

function DockItem({ mouseY, title, to, icon: IconCmp, end }) {
  const ref = useRef(null);
  const [showLabel, setShowLabel] = useState(false);
  const reduceMotion = useReducedMotion();

  // Distance from the mouse to this icon's centre, in px.
  const distance = useTransform(mouseY, (y) => {
    const box = ref.current?.getBoundingClientRect() ?? { y: 0, height: 0 };
    return y - box.y - box.height / 2;
  });

  // Close to the mouse = bigger. Springs make the size change feel physical.
  const grow = reduceMotion ? [BASE, BASE, BASE] : [BASE, MAX, BASE];
  const growIcon = reduceMotion ? [ICON_BASE, ICON_BASE, ICON_BASE] : [ICON_BASE, ICON_MAX, ICON_BASE];
  const size = useSpring(useTransform(distance, [-REACH, 0, REACH], grow), SPRING);
  const iconSize = useSpring(useTransform(distance, [-REACH, 0, REACH], growIcon), SPRING);

  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `dock-link${isActive ? ' active' : ''}`}
      aria-label={title}
      onMouseEnter={() => setShowLabel(true)}
      onMouseLeave={() => setShowLabel(false)}
      onFocus={() => setShowLabel(true)}
      onBlur={() => setShowLabel(false)}
    >
      <m.span ref={ref} className="dock-item" style={{ width: size, height: size }}>
        <AnimatePresence>
          {showLabel && (
            <m.span
              className="dock-label"
              initial={{ opacity: 0, x: -6, y: '-50%' }}
              animate={{ opacity: 1, x: 0, y: '-50%' }}
              exit={{ opacity: 0, x: -2, y: '-50%' }}
              transition={{ duration: 0.15 }}
              aria-hidden="true"
            >
              {title}
            </m.span>
          )}
        </AnimatePresence>
        <m.span className="dock-icon" style={{ width: iconSize, height: iconSize }}>
          <IconCmp width="100%" height="100%" />
        </m.span>
      </m.span>
    </NavLink>
  );
}

/**
 * Phones and narrow windows: a floating tab bar at the bottom of the screen.
 * Touch screens have no hover, so each icon keeps a short visible label.
 * items: [{ title, short, to, icon: Component, end }]
 */
export function MobileDock({ items }) {
  return (
    <nav className="mobile-dock" aria-label="Main">
      {items.map(({ title, short, to, icon: IconCmp, end }) => (
        <NavLink key={to} to={to} end={end} className={({ isActive }) => `mobile-dock-link${isActive ? ' active' : ''}`} aria-label={title}>
          <IconCmp width={20} height={20} />
          <span>{short || title}</span>
        </NavLink>
      ))}
    </nav>
  );
}
