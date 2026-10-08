// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

// Pointer movement (in px) needed before a press turns into a drag, so that
// plain clicks keep working.
const DRAG_THRESHOLD = 4;

// Distance (in px) moved by one arrow key press, and with Shift held
const KEYBOARD_STEP = 10;
const KEYBOARD_STEP_LARGE = 50;

const KEYBOARD_DELTAS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// Space-separated list for `aria-keyshortcuts` on a focusable control inside
// the draggable element
export const DRAGGABLE_POSITION_KEY_SHORTCUTS =
  Object.keys(KEYBOARD_DELTAS).join(' ');

// The element is anchored to the corner of its offset parent that it is
// closest to, so that it stays attached to that corner when the window is
// resized and grows away from it when the element itself changes size.
export type DraggablePositionType = Readonly<{
  horizontal: 'left' | 'right';
  vertical: 'top' | 'bottom';
  // Distance from the horizontal / vertical anchor edge, in px
  x: number;
  y: number;
}>;

type SizeType = Readonly<{ width: number; height: number }>;

// The element's box relative to its offset parent, in px
type LayoutType = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
  parentWidth: number;
  parentHeight: number;
}>;

type DragStateType = {
  pointerId: number;
  startX: number;
  startY: number;
  layout: LayoutType;
  isDragging: boolean;
};

export type UseDraggablePositionResultType = Readonly<{
  position: DraggablePositionType | undefined;
  isDragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  // Use as onClickCapture to swallow the click that ends a drag
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  // Arrow keys move the element while focus is inside it
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<HTMLElement>) => void;
}>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function measureLayout(element: HTMLElement): LayoutType | undefined {
  const parent = element.offsetParent;
  if (!(parent instanceof HTMLElement)) {
    return undefined;
  }

  const rect = element.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  return {
    left: rect.left - parentRect.left - parent.clientLeft,
    top: rect.top - parentRect.top - parent.clientTop,
    width: rect.width,
    height: rect.height,
    parentWidth: parent.clientWidth,
    parentHeight: parent.clientHeight,
  };
}

// Like measureLayout(), but based on where the element is heading rather than
// where it currently is, which differs while a CSS transition is running.
function getTargetLayout(
  element: HTMLElement,
  position: DraggablePositionType | undefined,
  size: SizeType
): LayoutType | undefined {
  const measured = measureLayout(element);
  if (!measured || !position) {
    return measured;
  }

  const { parentWidth, parentHeight } = measured;
  const { width, height } = size;
  const x = clamp(position.x, 0, parentWidth - width);
  const y = clamp(position.y, 0, parentHeight - height);
  return {
    left: position.horizontal === 'left' ? x : parentWidth - x - width,
    top: position.vertical === 'top' ? y : parentHeight - y - height,
    width,
    height,
    parentWidth,
    parentHeight,
  };
}

// Moves the element by (dx, dy), keeps it inside its offset parent and
// anchors it to the nearest corner.
function getMovedPosition(
  layout: LayoutType,
  dx: number,
  dy: number
): DraggablePositionType {
  const { width, height, parentWidth, parentHeight } = layout;
  const left = clamp(layout.left + dx, 0, parentWidth - width);
  const top = clamp(layout.top + dy, 0, parentHeight - height);

  const isLeft = left + width / 2 < parentWidth / 2;
  const isTop = top + height / 2 < parentHeight / 2;

  return {
    horizontal: isLeft ? 'left' : 'right',
    vertical: isTop ? 'top' : 'bottom',
    x: isLeft ? left : parentWidth - left - width,
    y: isTop ? top : parentHeight - top - height,
  };
}

export function getDraggablePositionStyle(
  position: DraggablePositionType | undefined,
  size: SizeType
): CSSProperties {
  if (!position) {
    return {};
  }
  // Percentages resolve against the offset parent, so this keeps the element
  // inside its container when the window shrinks or the element grows.
  return {
    [position.horizontal]: `clamp(0px, ${position.x}px, calc(100% - ${size.width}px))`,
    [position.vertical]: `clamp(0px, ${position.y}px, calc(100% - ${size.height}px))`,
  };
}

export function useDraggablePosition({
  initialPosition,
  onPositionChange,
  size,
}: {
  initialPosition?: DraggablePositionType;
  onPositionChange?: (position: DraggablePositionType) => void;
  // The element's rendered size, used for keyboard moves
  size: SizeType;
}): UseDraggablePositionResultType {
  const [position, setPosition] = useState<DraggablePositionType | undefined>(
    initialPosition
  );
  const [isDragging, setIsDragging] = useState(false);

  const dragStateRef = useRef<DragStateType | null>(null);
  const positionRef = useRef(position);
  const suppressClickRef = useRef(false);
  const hasUnsavedKeyboardMoveRef = useRef(false);
  const removeListenersRef = useRef<(() => void) | null>(null);

  const onPositionChangeRef = useRef(onPositionChange);
  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  }, [onPositionChange]);

  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    return () => {
      removeListenersRef.current?.();
    };
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    suppressClickRef.current = false;
    if (event.button !== 0 || dragStateRef.current) {
      return;
    }

    const element = event.currentTarget;
    const layout = measureLayout(element);
    if (!layout) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      layout,
      isDragging: false,
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || moveEvent.pointerId !== state.pointerId) {
        return;
      }

      const dx = moveEvent.clientX - state.startX;
      const dy = moveEvent.clientY - state.startY;
      if (!state.isDragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          return;
        }
        state.isDragging = true;
        setIsDragging(true);
        // Make sure the release is delivered to us even if it happens outside
        // of the window.
        try {
          element.setPointerCapture(state.pointerId);
        } catch {
          // The pointer is no longer active; pointerup/cancel will follow
        }
      }

      const nextPosition = getMovedPosition(state.layout, dx, dy);
      positionRef.current = nextPosition;
      setPosition(nextPosition);
    };

    // Also handles `lostpointercapture`, in case the capture ends without a
    // pointerup/pointercancel reaching the document.
    const onPointerEnd = (endEvent: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || endEvent.pointerId !== state.pointerId) {
        return;
      }
      removeListeners();

      if (state.isDragging) {
        // The click that follows this pointerup (dispatched in the same task)
        // should not be treated as a click on the element. It may also land
        // elsewhere, so don't let the flag outlive this task.
        if (endEvent.type === 'pointerup') {
          suppressClickRef.current = true;
          setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        }
        setIsDragging(false);
        if (positionRef.current) {
          onPositionChangeRef.current?.(positionRef.current);
        }
      }
    };

    const removeListeners = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      element.removeEventListener('lostpointercapture', onPointerEnd);
      dragStateRef.current = null;
      removeListenersRef.current = null;
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
    element.addEventListener('lostpointercapture', onPointerEnd);
    removeListenersRef.current = removeListeners;
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) {
      return;
    }
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const delta = KEYBOARD_DELTAS[event.key];
    if (
      !delta ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      dragStateRef.current
    ) {
      return;
    }

    const layout = getTargetLayout(
      event.currentTarget,
      positionRef.current,
      sizeRef.current
    );
    if (!layout) {
      return;
    }

    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    const nextPosition = getMovedPosition(
      layout,
      delta[0] * step,
      delta[1] * step
    );
    positionRef.current = nextPosition;
    hasUnsavedKeyboardMoveRef.current = true;
    setPosition(nextPosition);
  }, []);

  // Save once the key is released, not on every auto-repeated keydown
  const onKeyUp = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!KEYBOARD_DELTAS[event.key] || !hasUnsavedKeyboardMoveRef.current) {
      return;
    }
    hasUnsavedKeyboardMoveRef.current = false;
    if (positionRef.current) {
      onPositionChangeRef.current?.(positionRef.current);
    }
  }, []);

  return {
    position,
    isDragging,
    onPointerDown,
    onClickCapture,
    onKeyDown,
    onKeyUp,
  };
}
