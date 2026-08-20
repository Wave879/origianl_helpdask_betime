import frappe
from frappe.model.document import Document


class LessonLearned(Document):

    def after_save(self):
        # Sync to Knowledge Base as a Lesson Learned item
        self._sync_to_knowledge_base()

    def _sync_to_knowledge_base(self):
        content = (
            f"ปัญหา: {self.problem}\n\n"
            f"สาเหตุ: {self.root_cause or '-'}\n\n"
            f"วิธีแก้ไข: {self.solution}\n\n"
            f"ผลลัพธ์: {self.outcome or '-'}"
        )
        if self.linked_knowledge:
            kb = frappe.get_doc("AI Knowledge Base", self.linked_knowledge)
            kb.content = content
            kb.save(ignore_permissions=True)
        else:
            kb = frappe.new_doc("AI Knowledge Base")
            kb.title = self.title
            kb.category = "Lesson Learned"
            kb.source_type = "Manual"
            kb.content = content
            kb.project = self.project
            kb.tags = self.category
            kb.insert(ignore_permissions=True)
            self.db_set("linked_knowledge", kb.name, update_modified=False)
