
async function test() {
  try {
    console.log('Testing /api/elite-logo-transparent...');
    const res = await fetch('http://localhost:3000/api/elite-logo-transparent');
    console.log('Status:', res.status);
    console.log('Content-Type:', res.headers.get('content-type'));
    console.log('Content-Length:', res.headers.get('content-length'));
    const buffer = await res.arrayBuffer();
    console.log('Downloaded Byte Size:', buffer.byteLength);
  } catch (err) {
    console.error('Test failed:', err);
  }
}

test();
