package com.ekop.agent;

import com.linkedin.common.urn.Urn;
import com.linkedin.data.schema.ArrayDataSchema;
import com.linkedin.data.schema.RecordDataSchema;
import com.linkedin.metadata.models.registry.ConfigEntityRegistry;
import com.linkedin.metadata.models.registry.EntityRegistryException;
import com.linkedin.metadata.models.registry.MergedEntityRegistry;
import com.linkedin.metadata.models.registry.PatchEntityRegistry;
import com.linkedin.metadata.utils.EntityKeyUtils;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipFile;
import org.apache.maven.artifact.versioning.ComparableVersion;

/** Executes the pinned official loader/compatibility checker without a server.
 * Classpath contains ONLY test classes and pinned Core libraries, not generated
 * plugin classes. Otherwise parent-first loading could silently compare the new
 * schema to itself when loading the previous artifact.
 */
public final class PrivateSemanticRegistryCheck {
  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static Path unpack(Path archive) throws Exception {
    var root = Files.createTempDirectory("semantic-registry-check-");
    try (var zip = new ZipFile(archive.toFile())) {
      for (var entry : zip.stream().toList()) {
        var path = root.resolve(entry.getName()).normalize();
        require(path.startsWith(root), "Archive path escapes fixture root");
        if (entry.isDirectory()) Files.createDirectories(path);
        else {
          Files.createDirectories(path.getParent());
          try (var input = zip.getInputStream(entry)) { Files.copy(input, path); }
        }
      }
    }
    return root;
  }

  private static RecordDataSchema publicationSchema(PatchEntityRegistry registry) {
    var run = registry.getEntitySpec("dataProcessInstance").getAspectSpec("ekopAgentRun").getPegasusSchema();
    var decisions = (ArrayDataSchema) run.getField("decisions").getType().getDereferencedDataSchema();
    var decision = (RecordDataSchema) decisions.getItems().getDereferencedDataSchema();
    return (RecordDataSchema) decision.getField("publicationReview").getType().getDereferencedDataSchema();
  }

  public static void main(String[] args) throws Exception, EntityRegistryException {
    require(args.length == 2 || args.length == 3, "Expected candidate ZIP, version, optional previous ZIP");
    var coreStream = ConfigEntityRegistry.class.getClassLoader().getResourceAsStream("entity-registry.yml");
    require(coreStream != null, "Pinned Core registry resource missing");
    MergedEntityRegistry merged;
    try (coreStream) { merged = new MergedEntityRegistry(new ConfigEntityRegistry(coreStream)); }
    var originalEntityCount = merged.getEntitySpecs().size();
    if (args.length == 3) {
      var prior = new PatchEntityRegistry(unpack(Path.of(args[2])).toString(), "ekop-agent-tasks",
          new ComparableVersion("0.1.8"), null);
      require(publicationSchema(prior).getField("assets") == null,
          "Old artifact unexpectedly has Catalog scope: classpath contamination or wrong prior artifact");
      merged.apply(prior);
    }
    var candidate = new PatchEntityRegistry(unpack(Path.of(args[0])).toString(), "ekop-agent-tasks",
        new ComparableVersion(args[1]), null);
    require(publicationSchema(candidate).getField("assets").getOptional(), "Catalog scope not backward compatible");
    merged.apply(candidate);
    require(merged.getEntitySpecs().size() == originalEntityCount + 1, "Unexpected entity additions/removals");
    var privateEntity = merged.getEntitySpec("ekopSemanticReview");
    require(privateEntity.getKeyAspectSpec().getName().equals("ekopSemanticReviewKey"), "Wrong private key");
    for (String aspect : List.of("ekopSemanticTask", "ekopSemanticRun"))
      require(privateEntity.hasAspect(aspect), "Missing private aspect: " + aspect);
    require(!privateEntity.hasAspect("ownership") && !privateEntity.hasAspect("status"),
        "Fixed loader cannot reuse Core aspects; do not redeclare them in the plugin");
    require(!privateEntity.hasAspect("ekopAgentTask") && !privateEntity.hasAspect("ekopAgentRun"),
        "Private records alias legacy public aspects");
    require(!merged.getEntitySpec("dataJob").hasAspect("ekopSemanticTask"), "Private Task registered on public Job");
    require(!merged.getEntitySpec("dataProcessInstance").hasAspect("ekopSemanticRun"), "Private Run registered on public Run");
    for (String aspect : List.of("ekopSemanticReviewKey", "ekopSemanticTask", "ekopSemanticRun")) {
      var spec = privateEntity.getAspectSpec(aspect);
      require(spec.getSearchableFieldSpecs().isEmpty(), "Private content gained searchable fields");
      require(spec.getSearchableRefFieldSpecs().isEmpty(), "Private content gained searchable refs");
      require(spec.getRelationshipFieldSpecs().isEmpty(), "Private content gained graph edges");
    }
    var urn = Urn.createFromString("urn:li:ekopSemanticReview:opaque-fixture");
    var key = EntityKeyUtils.convertUrnToEntityKey(urn, privateEntity.getKeyAspectSpec());
    require(key.data().getString("id").equals("opaque-fixture"), "Native URN/key conversion failed");
    System.out.println("PASS: pinned Core registry + " + (args.length == 3 ? "independently loaded 0.1.8 + " : "")
        + args[1] + " via official Patch/MergedEntityRegistry; new native key, explicit-actor-policy shape, private-only aspects and no sensitive search/graph annotations. NO GMS deployment or ACL acceptance.");
  }
}
