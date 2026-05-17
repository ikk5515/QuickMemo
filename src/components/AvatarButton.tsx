import type { PublicRosterUser } from "../types";

interface AvatarButtonProps {
  user: PublicRosterUser;
  selected?: boolean;
  showRole?: boolean;
  onClick: () => void;
}

export function AvatarButton({ user, selected = false, showRole = true, onClick }: AvatarButtonProps) {
  return (
    <button className={`avatar-button ${selected ? "is-selected" : ""}`} type="button" onClick={onClick}>
      <span className="quick-key">{user.quickKey}</span>
      <span className="avatar-circle" style={{ background: user.color }}>
        {user.avatarText}
      </span>
      <span className="avatar-name">{user.displayName}</span>
      {showRole && user.isAdmin && <span className="avatar-role">관리자</span>}
    </button>
  );
}
