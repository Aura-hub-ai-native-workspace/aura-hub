import { motion } from 'framer-motion';
import { spring, type NavKey } from '@aura/core';
import { Button, Icon } from '@aura/ui';
import { PageContainer } from './PageContainer';
import { SECTION_IDENTITY } from '../shell/sections';

/**
 * A reserved environment — not an empty page. Each section arrives with
 * its own atmosphere (a drifting hue aura + a ghosted motif) and its own
 * guidance, so a space with no content yet still feels *inhabited* and
 * intentional. This is the antidote to the "dashboard" feeling.
 */
export function PlaceholderScreen({
  navKey,
  title,
  hint,
}: {
  navKey: NavKey;
  title: string;
  hint: string;
}) {
  const id = SECTION_IDENTITY[navKey];

  return (
    <PageContainer wide className="relative">
      {/* Ambient atmosphere in the section's hue — very subtle, drifting. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="aura-drift absolute -top-24 right-[8%] h-80 w-80 rounded-full blur-3xl"
          style={{ background: `radial-gradient(circle, ${id.hue}22 0%, transparent 70%)` }}
        />
        <div
          className="aura-drift absolute bottom-[6%] left-[10%] h-72 w-72 rounded-full blur-3xl"
          style={{ background: `radial-gradient(circle, ${id.hue}18 0%, transparent 70%)`, animationDelay: '-6s' }}
        />
      </div>

      <div className="relative grid min-h-[62vh] place-items-center">
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={spring.gentle}
          className="relative max-w-lg text-center"
        >
          {/* Ghosted motif behind the mark. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-20 flex justify-center opacity-[0.04]">
            <Icon name={id.motif} size={220} strokeWidth={0.6} style={{ color: id.hue }} />
          </div>

          {/* Section mark tile in the section hue. */}
          <div className="relative mx-auto mb-7 grid h-[72px] w-[72px] place-items-center">
            <div className="absolute inset-0 rounded-[26px] blur-xl" style={{ background: `${id.hue}33` }} />
            <div
              className="relative grid h-[72px] w-[72px] place-items-center rounded-[26px] border border-line bg-surface shadow-sm"
              style={{ color: id.hue }}
            >
              <Icon name={id.motif} size={30} strokeWidth={1.5} />
            </div>
          </div>

          <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
          <p className="mx-auto mt-2.5 max-w-md text-[14px] leading-relaxed text-text-muted">{hint}</p>

          {/* Guidance chips — quick, inviting entry points. */}
          {id.chips.length > 0 && (
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {id.chips.map((c) => (
                <button
                  key={c.label}
                  className="group inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 text-[12.5px] font-medium text-text-muted transition-all hover:border-line-strong hover:bg-surface-hover hover:text-text"
                >
                  <Icon name={c.icon} size={15} style={{ color: id.hue }} />
                  {c.label}
                </button>
              ))}
            </div>
          )}

          <div className="mt-7 flex justify-center gap-2.5">
            <Button variant="primary" icon="plus">Create</Button>
            <Button variant="ghost" icon="doc">Documentation</Button>
          </div>

          <p className="mt-6 text-[11.5px] tracking-wide text-text-subtle">{id.tagline}</p>
        </motion.div>
      </div>
    </PageContainer>
  );
}
