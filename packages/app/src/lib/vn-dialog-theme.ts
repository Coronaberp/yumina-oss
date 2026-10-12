/** Scope host portals to the visible VN chat; hidden cached chats cannot theme another page. */
export function activateVnDialogTheme(doc: Document): () => void {
  const previous = doc.body.getAttribute("data-yumina-dialog-theme");
  doc.body.setAttribute("data-yumina-dialog-theme", "vn");
  return () => {
    if (previous === null) doc.body.removeAttribute("data-yumina-dialog-theme");
    else doc.body.setAttribute("data-yumina-dialog-theme", previous);
  };
}
