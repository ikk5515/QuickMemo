import { ArrowLeft, BookOpen } from "lucide-react";
import { Link } from "react-router-dom";
import { UnlockPanel } from "../components/UnlockPanel";
import { useAuth } from "../context/AuthContext";
import { useVaultDecryptionSession } from "../context/VaultDecryptionContext";
import { usePrivateWikiData } from "../features/wiki/usePrivateWikiData";
import { WikiAssetEmbed, useWikiAssetReader } from "../features/wiki/WikiAssetEmbed";
import { WikiReader } from "../features/wiki/WikiReader";
import { hasFeatureAccess } from "../lib/featureAccess";
import "../styles/wiki.css";

export default function WikiPage() {
  const { firebaseUser, profile, privateKey } = useAuth();
  if (!firebaseUser || !profile || profile.uid !== firebaseUser.uid || !profile.isActive || !hasFeatureAccess(profile, "notes")) return null;
  if (!privateKey) return <div className="private-wiki private-wiki--locked"><WikiHomeLink /><UnlockPanel /></div>;
  return <WikiDataGate privateKey={privateKey} uid={profile.uid} />;
}

function WikiHomeLink() {
  return <Link className="wiki-home-link" to="/app"><ArrowLeft aria-hidden="true" size={16} />메모로 돌아가기</Link>;
}

function WikiDataGate({ privateKey, uid }: { privateKey: CryptoKey; uid: string }) {
  const data = usePrivateWikiData(uid, privateKey);
  const session = useVaultDecryptionSession();
  const assetReader = useWikiAssetReader(data.ready && session
    ? { uid, privateKey, session, snapshots: data.assetSnapshots, folders: data.folders } : null);
  if (!data.ready) return (
    <div className="private-wiki private-wiki--locked">
      <WikiHomeLink />
      <div className="wiki-state" role={data.error ? "alert" : "status"}>
        <BookOpen aria-hidden="true" size={30} />
        <h1>나의 위키</h1>
        <p>{data.error ?? "암호화된 메모를 안전하게 열고 있습니다."}</p>
        {data.error ? <button onClick={data.retry} type="button">다시 시도</button> : null}
      </div>
    </div>
  );
  return <WikiReader folders={data.folders} homeLink={{ href: "/app", label: "메모로 돌아가기" }} notes={data.notes}
    renderAsset={(reference, sourceEntry, onLinkClick) => <WikiAssetEmbed onLinkClick={onLinkClick} reader={assetReader} reference={reference} sourceEntry={sourceEntry} />} />;
}
