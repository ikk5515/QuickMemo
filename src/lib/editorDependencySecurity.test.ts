import { mergeAttributes } from "@tiptap/core";
import { DOMSerializer, Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

describe("editor dependency security", () => {
  it("does not turn a JSON prototype key into executable image attributes", () => {
    const attributes = mergeAttributes(
      { alt: "safe attachment" },
      JSON.parse('{"__proto__":{"src":"invalid:","onerror":"globalThis.editorCanary=true"}}')
    );
    const schema = new Schema({
      nodes: {
        doc: { content: "image" },
        image: { toDOM: () => ["img", attributes] },
        text: {}
      }
    });
    const documentNode = schema.node("doc", null, [schema.node("image")]);
    const rendered = DOMSerializer.fromSchema(schema).serializeFragment(documentNode.content);
    const image = rendered.querySelector("img");

    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(image).toHaveAttribute("alt", "safe attachment");
    expect(image).not.toHaveAttribute("onerror");
    expect(image).not.toHaveAttribute("src");
  });
});
