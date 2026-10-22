import { useEffect } from 'react';
import { SITE_COPY, type SiteCopy } from './site-copy';

/** Instance name from SITE_NAME at build time, e.g. "Watercooler" or "gang-bet". */
export const SITE_NAME = import.meta.env.SITE_NAME;

/** This instance's copy (SITE_COPY at build time). */
export const COPY: SiteCopy = SITE_COPY[import.meta.env.SITE_COPY];

/** index.html's title ("Name · tagline"), which the home page keeps. */
const SITE_TITLE = document.title;

/** Title the browser tab "页面 · 站名" while a page is shown. */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SITE_NAME}` : SITE_TITLE;
    return () => {
      document.title = SITE_TITLE;
    };
  }, [title]);
}
