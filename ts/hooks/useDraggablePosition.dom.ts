// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

// Pointer movement (in px) needed before a press turns into a drag, so that
// plain clicks keep working.
const DRAG_THRESHOLD = 4;

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

type DragStateType = {
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  width: number;
  height: number;
  parentWidth: number;
  parentHeight: number;
  isDragging: boolean;
};

export type UseDraggablePositionResultType = Readonly<{
  position: DraggablePositionType | undefined;
  isDragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  // Use as onClickCapture to swallow the click that ends a drag
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function getDraggablePositionStyle(
  position: DraggablePositionType | undefined,
  size: Readonly<{ width: number; height: number }>
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
}: {
  initialPosition?: DraggablePositionType;
  onPositionChange?: (position: DraggablePositionType) => void;
} = {}): UseDraggablePositionResultType {
  const [position, setPosition] = useState<DraggablePositionType | undefined>(
    initialPosition
  );
  const [isDragging, setIsDragging] = useState(false);

  const dragStateRef = useRef<DragStateType | null>(null);
  const positionRef = useRef(position);
  const suppressClickRef = useRef(false);
  const removeListenersRef = useRef<(() => void) | null>(null);

  const onPositionChangeRef = useRef(onPositionChange);
  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  }, [onPositionChange]);

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
    const parent = element.offsetParent;
    if (!(parent instanceof HTMLElement)) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left - parentRect.left - parent.clientLeft,
      startTop: rect.top - parentRect.top - parent.clientTop,
      width: rect.width,
      height: rect.height,
      parentWidth: parent.clientWidth,
      parentHeight: parent.clientHeight,
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
      }

      const left = clamp(
        state.startLeft + dx,
        0,
        state.parentWidth - state.width
      );
      const top = clamp(
        state.startTop + dy,
        0,
        state.parentHeight - state.height
      );

      const isLeft = left + state.width / 2 < state.parentWidth / 2;
      const isTop = top + state.height / 2 < state.parentHeight / 2;

      const nextPosition: DraggablePositionType = {
        horizontal: isLeft ? 'left' : 'right',
        vertical: isTop ? 'top' : 'bottom',
        x: isLeft ? left : state.parentWidth - left - state.width,
        y: isTop ? top : state.parentHeight - top - state.height,
      };
      positionRef.current = nextPosition;
      setPosition(nextPosition);
    };

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
      dragStateRef.current = null;
      removeListenersRef.current = null;
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
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

  return { position, isDragging, onPointerDown, onClickCapture };
}
