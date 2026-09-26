const fs = require('fs');

async function test() {
    try {
        console.log("Fetching from Vercel...");
        const res = await fetch("https://hospital-occu.vercel.app/api/occupancy/data");
        const text = await res.text();
        console.log("Status:", res.status);
        console.log("Body:", text.substring(0, 200));
    } catch(err) {
        console.error(err);
    }
}
test();
