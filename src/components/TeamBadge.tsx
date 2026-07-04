// Compact team badge: logo + optional name, with a colored ring reflecting
// the team's primary color. Used throughout the app anywhere a club is
// mentioned so brand identity is immediately visible.
import { getTeamLogo, getTeamColors } from "@/lib/team-branding";
import { useLeague } from "@/state/league";

interface TeamBadgeProps {
  team: string;
  size?: number; // px
  showName?: boolean;
  className?: string;
  nameClassName?: string;
  ringed?: boolean;
}

export function TeamBadge({
  team, size = 24, showName = false, className = "", nameClassName = "", ringed = true,
}: TeamBadgeProps) {
  const { state } = useLeague();
  const t = state.teams[team];
  const logo = getTeamLogo(t ?? { name: team });
  const colors = getTeamColors(t ?? { name: team });
  const primary = colors.primary ?? "hsl(var(--muted-foreground))";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span
        className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white"
        style={{
          width: size,
          height: size,
          boxShadow: ringed ? `0 0 0 2px ${primary}` : undefined,
        }}
      >
        {logo ? (
          <img
            src={logo}
            alt=""
            width={size}
            height={size}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="text-[10px] font-bold" style={{ color: primary }}>
            {team.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
      {showName && <span className={nameClassName}>{team}</span>}
    </span>
  );
}
