// One import for a page: Preact, its hooks, and an `html` tag bound to `h`.
// See README.md beside this file for the versions and the one local edit.
import htm from "./htm-3.1.1.mjs";
import { h } from "./preact-10.29.8.mjs";

export const html = htm.bind(h);
export {
  Component,
  Fragment,
  createContext,
  createRef,
  h,
  render,
} from "./preact-10.29.8.mjs";
export {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "./preact-hooks-10.29.8.mjs";
