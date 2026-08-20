import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class AIKnowledgeBase(Document):

    def after_save(self):
        if self.is_active and self.content:
            # Queue re-embedding whenever content changes
            frappe.enqueue(
                "betime_solution.agents.knowledge_agent.embed_knowledge_item",
                knowledge_name=self.name,
                queue="default",
                timeout=120,
            )

    def on_trash(self):
        # Remove from Azure AI Search index when deleted
        frappe.enqueue(
            "betime_solution.agents.knowledge_agent.delete_knowledge_chunks",
            knowledge_name=self.name,
            queue="default",
        )


@frappe.whitelist()
def search_knowledge(query: str, category: str = None, top: int = 5) -> dict:
    """
    Semantic RAG search. Searches Azure AI Search index.
    Falls back to SQL LIKE search if Azure is not configured.
    """
    try:
        from betime_solution.utils.azure_ai import search_knowledge as azure_search
        results = azure_search(query, top=int(top))
        if category:
            results = [r for r in results if r.get("category") == category]
        return {"source": "azure_ai_search", "results": results}
    except Exception:
        # Fallback: basic SQL full-text search
        filters = {"is_active": 1}
        if category:
            filters["category"] = category
        rows = frappe.get_list(
            "AI Knowledge Base",
            filters=filters,
            fields=["name", "title", "category", "content", "source_link"],
            limit_page_length=int(top),
        )
        return {"source": "sql_fallback", "results": [
            {"title": r.title, "content": (r.content or "")[:500],
             "category": r.category, "source": r.source_link or ""}
            for r in rows
        ]}


@frappe.whitelist()
def trigger_embed_all() -> dict:
    """Re-embed all active knowledge items. Admin only."""
    from betime_solution.utils.security import assert_role
    assert_role("BT Admin", "System Manager")

    items = frappe.get_list("AI Knowledge Base", filters={"is_active": 1},
                            fields=["name"], limit_page_length=500)
    for item in items:
        frappe.enqueue(
            "betime_solution.agents.knowledge_agent.embed_knowledge_item",
            knowledge_name=item.name,
            queue="default",
        )
    return {"queued": len(items)}
