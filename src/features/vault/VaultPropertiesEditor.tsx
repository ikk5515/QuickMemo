import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FrontmatterValue } from "../knowledge";
import {
  parsePropertyEditorValue,
  propertyEditorValue,
  removeFrontmatterProperty,
  setFrontmatterProperty
} from "./frontmatterEditing";

export interface VaultPropertiesEditorProps {
  disabled?: boolean;
  onChange: (source: string) => void;
  onError: (message: string) => void;
  properties: Readonly<Record<string, FrontmatterValue>>;
  source: string;
}

export function VaultPropertiesEditor({
  disabled = false,
  onChange,
  onError,
  properties,
  source
}: VaultPropertiesEditorProps) {
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  useEffect(() => {
    setDraftValues(Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, propertyEditorValue(value)])
    ));
  }, [properties]);

  function updateProperty(key: string) {
    try {
      const nextValue = parsePropertyEditorValue(draftValues[key] ?? "", properties[key]);
      onChange(setFrontmatterProperty(source, key, nextValue));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "속성을 수정하지 못했습니다.");
    }
  }

  function removeProperty(key: string) {
    try {
      onChange(removeFrontmatterProperty(source, key));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "속성을 삭제하지 못했습니다.");
    }
  }

  function addProperty() {
    const key = newKey.trim();
    if (!key) {
      onError("추가할 속성 이름을 입력해주세요.");
      return;
    }
    try {
      onChange(setFrontmatterProperty(source, key, newValue));
      setNewKey("");
      setNewValue("");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "속성을 추가하지 못했습니다.");
    }
  }

  return (
    <div className="vault-properties">
      <h3>Properties</h3>
      {Object.entries(properties).length === 0 ? <p>속성이 없습니다.</p> : null}
      <div className="vault-property-list">
        {Object.entries(properties).map(([key]) => (
          <div className="vault-property-row" key={key}>
            <label>
              <span>{key}</span>
              <input
                aria-label={`${key} 속성 값`}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraftValues((current) => ({ ...current, [key]: value }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    updateProperty(key);
                  }
                }}
                value={draftValues[key] ?? ""}
              />
            </label>
            <button
              aria-label={`${key} 속성 삭제`}
              disabled={disabled}
              onClick={() => removeProperty(key)}
              title="속성 삭제"
              type="button"
            >
              <Trash2 size={14} />
            </button>
            <button
              disabled={disabled || draftValues[key] === propertyEditorValue(properties[key])}
              onClick={() => updateProperty(key)}
              type="button"
            >
              적용
            </button>
          </div>
        ))}
      </div>
      <form className="vault-property-add" onSubmit={(event) => { event.preventDefault(); addProperty(); }}>
        <input
          aria-label="새 속성 이름"
          disabled={disabled}
          onChange={(event) => setNewKey(event.currentTarget.value)}
          placeholder="속성 이름"
          value={newKey}
        />
        <input
          aria-label="새 속성 값"
          disabled={disabled}
          onChange={(event) => setNewValue(event.currentTarget.value)}
          placeholder="값"
          value={newValue}
        />
        <button aria-label="속성 추가" disabled={disabled} type="submit"><Plus size={14} /> 추가</button>
      </form>
      <small>배열 값은 쉼표로 구분합니다. 지원하지 않는 중첩 YAML은 원본을 보호하기 위해 편집하지 않습니다.</small>
    </div>
  );
}
