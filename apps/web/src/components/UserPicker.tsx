import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AdminUser } from '@watercooler/shared';
import clsx from 'clsx';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Avatar } from './Avatar';
import { Badge, Input } from './ui';

const SHOWN = 8;

/** Mark the letters of `text` that `query` matched: a contiguous run if there is one, else in order. */
function highlight(text: string, query: string): ReactNode {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const marked = new Set<number>();
  const at = lower.indexOf(q);
  if (at >= 0) {
    for (let i = at; i < at + q.length; i++) marked.add(i);
  } else {
    let from = 0;
    for (const ch of q) {
      const i = lower.indexOf(ch, from);
      if (i < 0) return text;
      marked.add(i);
      from = i + 1;
    }
  }
  return [...text].map((ch, i) =>
    marked.has(i) ? (
      <span key={i} className="text-brand">
        {ch}
      </span>
    ) : (
      ch
    ),
  );
}

/**
 * Username field for /admin with a search dropdown: one typed letter already lists the people
 * whose username or display name match it fuzzily (see listUsers on the server). Pick with the
 * mouse, or the arrow keys and Enter; Enter without an open list submits the form as usual.
 */
export function UserPicker({
  value,
  onChange,
  exclude,
  placeholder = '输入用户名或昵称搜索',
}: {
  value: string;
  onChange: (username: string) => void;
  /** Leave these people out of the list (they can still be typed). */
  exclude?: (user: AdminUser) => boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const q = value.trim();
  const { data } = useQuery({
    queryKey: ['admin', 'users', q, 'picker'],
    queryFn: () => api.admin.users(q, SHOWN * 2),
    enabled: open && q !== '',
    placeholderData: keepPreviousData,
  });
  const options = (data ?? []).filter((u) => !exclude?.(u)).slice(0, SHOWN);
  const shown = open && q !== '' && data !== undefined;
  const current = Math.min(active, options.length - 1);

  const pick = (u: AdminUser) => {
    onChange(u.username);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown) {
        setOpen(true);
        setActive(0);
      } else if (options.length > 0) {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((current + step + options.length) % options.length);
      }
    } else if (e.key === 'Enter' && shown && options[current]) {
      e.preventDefault();
      pick(options[current]);
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && options[current] ? `${listId}-${options[current].id}` : undefined}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-[0_8px_24px_rgb(29_33_41/0.12)]"
        >
          {options.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-${u.id}`}
              role="option"
              aria-selected={i === current}
              // Pick on mousedown, before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
              onMouseEnter={() => setActive(i)}
              className={clsx(
                'flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-2 text-sm',
                i === current && 'bg-fill',
              )}
            >
              <Avatar id={u.id} name={u.displayName} size={24} />
              <span className="min-w-0 flex-1 truncate">
                {highlight(u.displayName, q)} <span className="text-faint">@{highlight(u.username, q)}</span>
              </span>
              {u.isAdmin && <Badge>管理员</Badge>}
            </li>
          ))}
          {options.length === 0 && <li className="px-2.5 py-2 text-sm text-faint">没有匹配的用户</li>}
        </ul>
      )}
    </div>
  );
}
