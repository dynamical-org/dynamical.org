// One import for a page: Preact, its hooks, and an `html` tag bound to `h`.
// See README.md beside this file for the versions and the one local edit.
import htm from "./htm.mjs";
import { h } from "./preact.mjs";

export const html = htm.bind(h);
export {
  Component,
  Fragment,
  createContext,
  createRef,
  h,
  render,
} from "./preact.mjs";
export {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "./preact-hooks.mjs";
