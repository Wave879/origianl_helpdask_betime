"""
Knowledge Agent — RAG pipeline:
  - Embed knowledge items into Azure AI Search
  - Sync SharePoint documents to Knowledge Base
  - Delete chunks on record removal
"""

import frappe
from frappe.utils import now_datetime


def embed_knowledge_item(knowledge_name: str):
    """Chunk and embed a single AI Knowledge Base item into Azure AI Search."""
    doc = frappe.get_doc("AI Knowledge Base", knowledge_name)
    if not doc.content:
        return

    try:
        from betime_solution.utils.azure_ai import index_knowledge_chunk
        # Simple chunking: split by paragraph (max ~500 chars each)
        chunks = _chunk_text(doc.content, max_chars=500)
        for i, chunk in enumerate(chunks):
            chunk_id = f"{knowledge_name}-chunk-{i}"
            index_knowledge_chunk(
                chunk_id=chunk_id,
                title=doc.title,
                content=chunk,
                category=doc.category,
                source_link=doc.source_link or knowledge_name,
            )
        frappe.db.set_value("AI Knowledge Base", knowledge_name, {
            "embedding_status": "Completed",
            "last_embedded": now_datetime(),
            "chunk_count": len(chunks),
        }, update_modified=False)
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"Embed Error: {knowledge_name}")
        frappe.db.set_value("AI Knowledge Base", knowledge_name,
                            "embedding_status", "Failed", update_modified=False)
    frappe.db.commit()


def delete_knowledge_chunks(knowledge_name: str):
    """Remove all chunks for a deleted knowledge item from Azure AI Search."""
    try:
        from azure.search.documents import SearchClient
        from azure.core.credentials import AzureKeyCredential
        client = SearchClient(
            endpoint=frappe.conf.get("azure_search_endpoint"),
            index_name=frappe.conf.get("azure_search_index"),
            credential=AzureKeyCredential(frappe.conf.get("azure_search_key")),
        )
        # Search for all chunks belonging to this item and delete
        results = client.search(search_text="", filter=f"source_link eq '{knowledge_name}'",
                                select=["id"])
        ids_to_delete = [{"id": r["id"]} for r in results]
        if ids_to_delete:
            client.delete_documents(ids_to_delete)
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"Delete Chunks Error: {knowledge_name}")


def sync_sharepoint_knowledge():
    """
    Scheduler: sync documents from SharePoint into AI Knowledge Base.
    Requires azure_sharepoint_site_id in site_config.json.
    """
    site_id = frappe.conf.get("azure_sharepoint_site_id")
    if not site_id:
        return

    try:
        docs = _list_sharepoint_documents(site_id)
        for sp_doc in docs:
            _upsert_knowledge_from_sharepoint(sp_doc)
        frappe.db.commit()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "SharePoint Sync Error")


def _list_sharepoint_documents(site_id: str) -> list:
    """List documents from a SharePoint site using Microsoft Graph API."""
    import httpx
    from azure.identity import ClientSecretCredential
    credential = ClientSecretCredential(
        tenant_id=frappe.conf.get("azure_tenant_id"),
        client_id=frappe.conf.get("azure_client_id"),
        client_secret=frappe.conf.get("azure_client_secret"),
    )
    token = credential.get_token("https://graph.microsoft.com/.default").token
    url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/drive/root/children"
    response = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    response.raise_for_status()
    return response.json().get("value", [])


def _upsert_knowledge_from_sharepoint(sp_doc: dict):
    """Create or update AI Knowledge Base entry for a SharePoint document."""
    web_url = sp_doc.get("webUrl", "")
    name = sp_doc.get("name", "Unnamed")
    existing = frappe.db.get_value("AI Knowledge Base",
                                   {"source_link": web_url, "source_type": "SharePoint"}, "name")
    if not existing:
        kb = frappe.new_doc("AI Knowledge Base")
        kb.title = name
        kb.category = "Other"
        kb.source_type = "SharePoint"
        kb.source_link = web_url
        kb.content = f"SharePoint ไฟล์: {name}\nURL: {web_url}"
        kb.insert(ignore_permissions=True)


def _chunk_text(text: str, max_chars: int = 500) -> list[str]:
    """Split text into chunks at paragraph boundaries."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks, current = [], ""
    for para in paragraphs:
        if len(current) + len(para) + 2 > max_chars and current:
            chunks.append(current.strip())
            current = para
        else:
            current += ("\n\n" + para if current else para)
    if current:
        chunks.append(current.strip())
    return chunks or [text[:max_chars]]
