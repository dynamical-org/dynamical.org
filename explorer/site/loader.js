// The explorer (explorer/, built to /explorer/) and its data load only on this click.
const section = document.querySelector(".explore");
const map = section.querySelector(".explore-map");
const button = map.querySelector("button");
const preview = [...map.children];
button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const { mount } = await import("/explorer/explorer.js");
    map.replaceChildren();
    mount(map, JSON.parse(section.dataset.options));
  } catch (error) {
    console.error(error);
    map.replaceChildren(...preview);
    button.disabled = false;
    button.textContent = "Couldn't load the map. Try again";
  }
});
