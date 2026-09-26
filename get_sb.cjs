const fs = require('fs');

async function test() {
    const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1dm9tY3hiZ2xkZ3RtdXF0eW1rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODkwNTQ4MSwiZXhwIjoyMTA0NDgxNDgxfQ.qd80QNiyhjO51Ky4zxKmzXtOb-bB4hFvhZ3cYnVoyn0";

    const res = await fetch("https://uuvomcxbgldgtmuqtymk.supabase.co/rest/v1/rtdb_nodes?path=eq.state/occupancy", {
        headers: {
            "apikey": key,
            "Authorization": "Bearer " + key
        }
    });
    const data = await res.json();
    fs.writeFileSync("sb_dump.json", JSON.stringify(data, null, 2));
    console.log("Dumped to sb_dump.json");
}
test();
