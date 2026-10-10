import { describe, it, expect } from 'vitest';
import {
  inferPointSpace,
  inferBoxSpace,
  scrollForPagePoint,
  scrollForPageBox,
  pagePointToViewport,
  pageBoxToViewport,
  pointIntoFrame,
  boxIntoFrame,
} from './coords';

const vp = { w: 1280, h: 800 };

describe('inferPointSpace', () => {
  it('keeps in-viewport points as viewport space', () => {
    expect(inferPointSpace({ x: 0, y: 0 }, vp)).toBe('viewport');
    expect(inferPointSpace({ x: 640, y: 400 }, vp)).toBe('viewport');
  });

  it('treats points beyond any viewport edge as page space', () => {
    expect(inferPointSpace({ x: 640, y: 900 }, vp)).toBe('page');
    expect(inferPointSpace({ x: 1300, y: 400 }, vp)).toBe('page');
    expect(inferPointSpace({ x: -1, y: 400 }, vp)).toBe('page');
  });
});

describe('inferBoxSpace', () => {
  it('keeps fully contained boxes as viewport space', () => {
    expect(inferBoxSpace({ x: 10, y: 10, w: 100, h: 100 }, vp)).toBe('viewport');
  });

  it('treats boxes crossing any edge as page space', () => {
    expect(inferBoxSpace({ x: 10, y: 700, w: 100, h: 200 }, vp)).toBe('page');
    expect(inferBoxSpace({ x: 1200, y: 10, w: 200, h: 100 }, vp)).toBe('page');
    expect(inferBoxSpace({ x: -5, y: 10, w: 100, h: 100 }, vp)).toBe('page');
  });
});

describe('page → viewport conversions', () => {
  it('centers a page point in the viewport', () => {
    const scroll = scrollForPagePoint({ x: 500, y: 1200 }, vp);
    expect(scroll).toEqual({ x: 500 - 640, y: 1200 - 400 });
    const vpPoint = pagePointToViewport({ x: 500, y: 1200 }, scroll);
    expect(vpPoint).toEqual({ x: 640, y: 400 });
  });

  it('centers a page box in the viewport', () => {
    const box = { x: 200, y: 2000, w: 400, h: 300 };
    const scroll = scrollForPageBox(box, vp);
    expect(scroll).toEqual({ x: 200 + 200 - 640, y: 2000 + 150 - 400 });
    const vpBox = pageBoxToViewport(box, scroll);
    expect(vpBox).toEqual({ x: box.x - scroll.x, y: box.y - scroll.y, w: 400, h: 300 });
    // The box center lands at the viewport center.
    expect(vpBox.x + vpBox.w / 2).toBeCloseTo(vp.w / 2);
    expect(vpBox.y + vpBox.h / 2).toBeCloseTo(vp.h / 2);
  });

  it('round-trips viewport-space coordinates unchanged (scroll 0)', () => {
    const scroll = { x: 0, y: 0 };
    expect(pagePointToViewport({ x: 12, y: 34 }, scroll)).toEqual({ x: 12, y: 34 });
    expect(pageBoxToViewport({ x: 1, y: 2, w: 3, h: 4 }, scroll)).toEqual({
      x: 1, y: 2, w: 3, h: 4,
    });
  });
});

describe('parent → child frame conversions', () => {
  const origin = { x: 100, y: 200 }; // iframe content box origin in parent viewport

  it('maps a parent point into the child viewport', () => {
    expect(pointIntoFrame({ x: 140, y: 260 }, origin)).toEqual({ x: 40, y: 60 });
  });

  it('maps a parent box into the child viewport', () => {
    expect(boxIntoFrame({ x: 110, y: 220, w: 50, h: 60 }, origin)).toEqual({
      x: 10, y: 20, w: 50, h: 60,
    });
  });

  it('keeps sizes untouched (translation only)', () => {
    const box = { x: 0, y: 0, w: 300, h: 500 };
    expect(boxIntoFrame(box, origin).w).toBe(300);
    expect(boxIntoFrame(box, origin).h).toBe(500);
  });
});
