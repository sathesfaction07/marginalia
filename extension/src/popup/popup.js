const submitBtn = document.getElementById("submit");
const queryInput = document.getElementById("query");
const regionSelect = document.getElementById("region");
const resultDiv = document.getElementById("result");
const answerDiv = document.getElementById("answer");
const confidenceSpan = document.getElementById("confidence");
const cacheBadge = document.getElementById("cache-badge");
const sourcesDiv = document.getElementById("sources");
const errorDiv = document.getElementById("error");
const feedbackDiv = document.getElementById("feedback");

let lastQueryId = null;

submitBtn.addEventListener("click", handleSubmit);
queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
});
document.getElementById("helpful").addEventListener("click", () => sendFeedback(true));
document.getElementById("not-helpful").addEventListener("click", () => sendFeedback(false));

async function handleSubmit() {
    const query = queryInput.value.trim();
    if (!query) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Thinking...";
    errorDiv.classList.remove("visible");
    resultDiv.classList.remove("visible");
    feedbackDiv.classList.remove("visible");

    const response = await chrome.runtime.sendMessage({
        type: "QUERY",
        payload: { query, region: regionSelect.value, process: "" },
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "Ask";

    if (response.error) {
        errorDiv.textContent = response.error;
        errorDiv.classList.add("visible");
        return;
    }

    const { data, fromCache } = response;
    lastQueryId = `${Date.now()}`;

    answerDiv.textContent = data.answer;
    confidenceSpan.textContent = data.confidence;
    confidenceSpan.className = `confidence ${data.confidence}`;
    cacheBadge.textContent = fromCache ? "(cached)" : "";
    sourcesDiv.textContent = data.sources.length ? `Sources: ${data.sources.join(", ")}` : "";

    resultDiv.classList.add("visible");
    feedbackDiv.classList.add("visible");
}

async function sendFeedback(helpful) {
    await chrome.runtime.sendMessage({
        type: "FEEDBACK",
        payload: { queryId: lastQueryId, helpful, correction: "" },
    });
    feedbackDiv.classList.remove("visible");
}
