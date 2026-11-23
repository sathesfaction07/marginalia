// Listens for page context that might be useful for auto-populating the query.
// For now: detects if the user is on a case management page and extracts the case ID.

(function () {
    // `[_\s-]?` includes a SPACE. Without it the pattern matched case_id, case-id and
    // caseid but NOT "Case ID:", which is how a page actually renders it for a human -- so
    // the script missed the single most common form of the thing it exists to find.
    //
    // Known cost, accepted: one optional space also lets "in case Idaho" match and capture
    // "aho". A false pre-populated id is recoverable (the associate edits the box); silently
    // never pre-populating is not visible at all.
    const caseIdPattern = /case[_\s-]?id[:\s]*([A-Z0-9-]+)/i;

    function detectCaseContext() {
        const bodyText = document.body?.innerText?.slice(0, 5000) || "";
        const match = bodyText.match(caseIdPattern);
        if (match) {
            chrome.storage.session.set({ currentCaseId: match[1] });
        }
    }

    if (document.readyState === "complete") {
        detectCaseContext();
    } else {
        window.addEventListener("load", detectCaseContext);
    }
})();
