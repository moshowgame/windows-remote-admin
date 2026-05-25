CodeMirror.defineMode("logHighlight", function(config, parserConfig) {
    const keywords = {
        "ERROR": "keyword",
        "WARN": "keyword",
        "INFO": "keyword",
        "DEBUG": "keyword",
        "TRACE": "keyword"
    };

    function tokenBase(stream, state) {
        const ch = stream.next();
        if (ch === "[") {
            stream.eatWhile(/[\w\s:]/);
            stream.eat("]");
            return "bracket";
        }
        if (ch === "(") {
            stream.eatWhile(/[\w\s:]/);
            stream.eat(")");
            return "bracket";
        }
        if (/\d/.test(ch)) {
            stream.eatWhile(/\d/);
            return "number";
        }
        if (/[a-z]/i.test(ch)) {
            stream.eatWhile(/[a-z_]/i);
            const cur = stream.current();
            return keywords[cur] || null;
        }
        return null;
    }

    return {
        startState: function() {
            return {};
        },
        token: function(stream, state) {
            return tokenBase(stream, state);
        }
    };
});

CodeMirror.defineMIME("text/x-log", "logHighlight");