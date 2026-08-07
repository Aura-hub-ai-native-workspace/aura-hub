import { motion } from 'framer-motion';
import { Icon, type IconName } from '@aura/ui';

export interface ProviderCardProps {
  icon: IconName;
  name: string;
  description: string;
  badges: string[];
  selected: boolean;
  connected: boolean;
  accent: string;
  onSelect: () => void;
  onGetKey: () => void;
}

/**
 * ProviderCard — a floating glass tile for one real, connectable provider.
 * Used for the two "recommended" cards and every entry in "Other providers".
 */
export function ProviderCard({ icon, name, description, badges, selected, connected, accent, onSelect, onGetKey }: ProviderCardProps) {
  return (
    <motion.div
      layout
      whileHover={{ y: -3 }}
      transition={{ type: 'spring', stiffness: 340, damping: 30 }}
      onClick={onSelect}
      className="relative cursor-pointer rounded-3xl border p-5 backdrop-blur-xl transition-colors"
      style={{
        borderColor: selected ? accent : 'rgba(255,255,255,0.10)',
        background: selected
          ? `linear-gradient(160deg, ${accent}22, rgba(255,255,255,0.03))`
          : 'linear-gradient(160deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))',
        boxShadow: selected ? `0 0 0 1px ${accent}55, 0 18px 40px -20px ${accent}66` : '0 10px 30px -18px rgba(0,0,0,0.6)',
      }}
    >
      {connected && (
        <span className="absolute right-4 top-4 flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-300">
          <Icon name="check" size={11} /> Connected
        </span>
      )}

      <div className="flex items-center gap-3">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl"
          style={{ background: `${accent}22`, color: accent }}
        >
          <Icon name={icon} size={20} strokeWidth={1.6} />
        </span>
        <div className="min-w-0">
          <div className="text-[16px] font-semibold text-white">{name}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {badges.map((b) => (
              <span key={b} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/60">
                {b}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-3.5 text-[12.5px] leading-relaxed text-white/55">{description}</p>

      <button
        onClick={(e) => { e.stopPropagation(); onGetKey(); }}
        className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] py-2.5 text-[12.5px] font-medium text-white/80 transition-colors hover:bg-white/[0.09] hover:text-white"
      >
        Create {name} API Key
        <Icon name="arrow-right" size={13} />
      </button>
    </motion.div>
  );
}
