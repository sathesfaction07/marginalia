#!/usr/bin/env bash
set -e

VENV_DIR="backend/.venv"

detect_os() { case "$(uname -s)" in Linux*) OS="linux";; Darwin*) OS="macos";; MINGW*|MSYS*|CYGWIN*) OS="windows";; *) OS="unknown";; esac; echo "Detected OS: $OS"; }
find_python() { for cmd in python3.12 python3.11 python3 python; do if command -v "$cmd" &>/dev/null; then PYTHON="$cmd"; echo "Using: $PYTHON"; return 0; fi; done; exit 1; }

setup_venv() {
    [ -d "$VENV_DIR" ] && echo "Venv exists — reusing." || $PYTHON -m venv "$VENV_DIR"
    if [ "$OS" = "windows" ]; then source "$VENV_DIR/Scripts/activate"; else source "$VENV_DIR/bin/activate"; fi
    pip install --upgrade pip --quiet
    cd backend && pip install -e ".[dev]" --quiet && cd ..
    echo "Dependencies installed."
}

select_backend() {
    echo ""
    echo "  PolicyAssist retrieval backend:"
    echo "  1) Keyword matching (no cloud, zero setup)"
    echo "  2) AWS Bedrock Knowledge Bases (managed RAG)"
    echo "  3) ChromaDB (local semantic search — downloads 400MB model)"
    read -p "Selection [1/2/3]: " CHOICE
    case "$CHOICE" in
        2) setup_aws_kb;;
        3) setup_chromadb;;
        *) echo "Using keyword backend.";;
    esac
}

setup_aws_kb() {
    read -p "AWS Account ID: " ACCT
    read -p "Region [us-east-1]: " REGION; REGION=${REGION:-us-east-1}
    read -p "Bedrock Knowledge Base ID: " KB_ID
    ROLE="PolicyAssist-AppRole"
    POLICY=$(cat <<EOF
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["bedrock:InvokeModel"],"Resource":"arn:aws:bedrock:${REGION}::foundation-model/*"},
  {"Effect":"Allow","Action":["bedrock:Retrieve"],"Resource":"arn:aws:bedrock:${REGION}:${ACCT}:knowledge-base/${KB_ID}"}
]}
EOF
)
    TRUST="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::${ACCT}:root\"},\"Action\":\"sts:AssumeRole\"}]}"

    aws iam get-role --role-name "$ROLE" &>/dev/null 2>&1 || aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" --output text --query 'Role.Arn'
    aws iam put-role-policy --role-name "$ROLE" --policy-name "PolicyAssist-Bedrock" --policy-document "$POLICY" 2>/dev/null

    cat > backend/.env <<EOF
PA_RETRIEVAL_BACKEND=bedrock_kb
PA_BEDROCK_REGION=${REGION}
PA_BEDROCK_KB_ID=${KB_ID}
EOF
    echo "Bedrock KB backend configured."
}

setup_chromadb() {
    cd backend && pip install "policy-assist[chromadb]" --quiet && cd ..
    cat > backend/.env <<EOF
PA_RETRIEVAL_BACKEND=chromadb
EOF
    echo "ChromaDB backend configured. First query will download the embedding model (~400MB)."
}

run_app() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Starting PolicyAssist..."
    echo "  Backend: http://localhost:8000"
    echo "  Extension: Load extension/ as unpacked in chrome://extensions"
    echo "═══════════════════════════════════════════════════════════════"

    [ -f backend/.env ] && export $(grep -v '^#' backend/.env | xargs)
    cd backend && uvicorn policy_assist.app:app --port 8000
}

main() {
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║            PolicyAssist — Setup & Run                        ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    detect_os; find_python; setup_venv; select_backend; run_app
}

main "$@"
