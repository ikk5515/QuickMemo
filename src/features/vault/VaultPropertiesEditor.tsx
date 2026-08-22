import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FrontmatterValue } from "../knowledge";
import {
  inferVaultPropertyType,
  parseTypedPropertyEditorValue,
  propertyEditorValue,
  removeFrontmatterProperty,
  setFrontmatterProperty,
  type VaultPropertyType
} from "./frontmatterEditing";
import "./vaultProperties.css";

const propertyTypeLabels: Record<VaultPropertyType, string> = {
  text: "텍스트",
  list: "목록",
  number: "숫자",
  checkbox: "체크박스",
  date: "날짜",
  datetime: "날짜와 시간",
  tags: "태그"
};

const propertyTypes = Object.keys(propertyTypeLabels) as VaultPropertyType[];

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
  const [draftTypes, setDraftTypes] = useState<Record<string, VaultPropertyType>>({});
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newType, setNewType] = useState<VaultPropertyType>("text");

  useEffect(() => {
    setDraftValues(Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, propertyEditorValue(value)])
    ));
    setDraftTypes(Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, inferVaultPropertyType(key, value)])
    ));
  }, [properties]);

  function updateProperty(key: string) {
    try {
      const nextValue = parseTypedPropertyEditorValue(
        draftValues[key] ?? "",
        draftTypes[key] ?? inferVaultPropertyType(key, properties[key])
      );
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
      onChange(setFrontmatterProperty(source, key, parseTypedPropertyEditorValue(newValue, newType)));
      setNewKey("");
      setNewValue("");
      setNewType("text");
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
            <span className="vault-property-name">{key}</span>
            <select
              aria-label={`${key} 속성 유형`}
              disabled={disabled}
              onChange={(event) => setDraftTypes((current) => ({
                ...current,
                [key]: event.currentTarget.value as VaultPropertyType
              }))}
              value={draftTypes[key] ?? inferVaultPropertyType(key, properties[key])}
            >
              {propertyTypes.map((type) => <option key={type} value={type}>{propertyTypeLabels[type]}</option>)}
            </select>
            <label className="vault-property-value">
              <span className="sr-only">{key} 속성 값</span>
              {(draftTypes[key] ?? inferVaultPropertyType(key, properties[key])) === "checkbox" ? (
                <input
                  aria-label={`${key} 속성 값`}
                  checked={(draftValues[key] ?? "false") === "true"}
                  disabled={disabled}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setDraftValues((current) => ({ ...current, [key]: String(checked) }));
                  }}
                  type="checkbox"
                />
              ) : (
                <input
                  aria-label={`${key} 속성 값`}
                  disabled={disabled}
                  inputMode={(draftTypes[key] ?? inferVaultPropertyType(key, properties[key])) === "number" ? "decimal" : undefined}
                  onChange={(event) => {
                    const value = event.currentTarget.value.replace(/[\r\n]/gu, " ");
                    setDraftValues((current) => ({ ...current, [key]: value }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      updateProperty(key);
                    }
                  }}
                  placeholder={(draftTypes[key] === "list" || draftTypes[key] === "tags") ? "쉼표로 구분" : undefined}
                  type={draftTypes[key] === "date" ? "date" : draftTypes[key] === "datetime" ? "datetime-local" : draftTypes[key] === "number" ? "number" : "text"}
                  value={draftValues[key] ?? ""}
                />
              )}
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
        <select
          aria-label="새 속성 유형"
          disabled={disabled}
          onChange={(event) => setNewType(event.currentTarget.value as VaultPropertyType)}
          value={newType}
        >
          {propertyTypes.map((type) => <option key={type} value={type}>{propertyTypeLabels[type]}</option>)}
        </select>
        <input
          aria-label="새 속성 값"
          disabled={disabled}
          onChange={(event) => setNewValue(event.currentTarget.value)}
          placeholder={newType === "list" || newType === "tags" ? "쉼표로 구분" : "값"}
          type={newType === "date" ? "date" : newType === "datetime" ? "datetime-local" : newType === "number" ? "number" : "text"}
          value={newValue}
        />
        <button aria-label="속성 추가" disabled={disabled} type="submit"><Plus size={14} /> 추가</button>
      </form>
      <small>목록과 태그는 쉼표로 구분합니다. 지원하지 않는 중첩 YAML은 원본을 보호하기 위해 편집하지 않습니다.</small>
    </div>
  );
}
