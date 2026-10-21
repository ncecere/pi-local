interface Node {
  type: string;
  children?: Node[];
}

/** Keep model text like <string> visible. Raw HTML is text, never executable markup.
 * Working on the syntax tree leaves code, autolinks and link destinations alone.
 */
export function remarkLiteralHtml() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (node.type === 'html') node.type = 'text';
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
