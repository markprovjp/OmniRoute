async function testCompletion() {
  const apiKey = "qrouter_sk_Uerrq-5MN9GEQr0qWvuU4ziwfSvJzjbV";
  const url = "http://localhost:20132/v1/chat/completions";
  const payload = {
    model: "cx/gpt-5.5",
    messages: [{ role: "user", content: "Hello, who are you? Answer in 1 short sentence." }],
    stream: false,
  };

  console.log("Sending request to:", url);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    console.log("Response status:", res.status);
    const data = await res.json();
    console.log("Response data:", JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Request failed:", error);
  }
}

testCompletion();
